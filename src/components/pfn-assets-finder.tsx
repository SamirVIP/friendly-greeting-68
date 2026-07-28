import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2, Shield, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type EventType = "TW" | "FW" | "DW" | "O" | "MS" | "STORE";
type Region = "SG" | "NA" | "EU";

type LinkItem = {
  id: string;
  region: Region;
  eventType: EventType;
  label: string;
  word: string;
  number: number;
  templateWord: string | null;
  url: string;
  check: { url: string; ok: boolean; status: number | null };
};

const EVENT_OPTIONS: Array<{ value: EventType; label: string }> = [
  { value: "TW", label: "Token Wheel (TW)" },
  { value: "FW", label: "Faded Wheel (FW)" },
  { value: "DW", label: "Double Wheel (DW)" },
  { value: "O", label: "Luck Royale (O)" },
  { value: "MS", label: "Moco Store (MS)" },
  { value: "STORE", label: "Store" },
];

const REGION_OPTIONS: Array<{ value: Region; label: string }> = [
  { value: "SG", label: "Singapore" },
  { value: "NA", label: "North America" },
  { value: "EU", label: "Europe" },
];

const PRESETS: Record<string, { regions: Region[]; eventTypes: EventType[] }> = {
  ALL: { regions: ["SG", "NA", "EU"], eventTypes: ["TW", "FW", "DW", "O", "MS", "STORE"] },
  SG_ALL: { regions: ["SG"], eventTypes: ["TW", "FW", "DW", "O", "MS", "STORE"] },
  NA_ALL: { regions: ["NA"], eventTypes: ["TW", "FW", "DW", "O", "MS", "STORE"] },
  EU_ALL: { regions: ["EU"], eventTypes: ["TW", "FW", "DW", "O", "MS", "STORE"] },
  SG_TW: { regions: ["SG"], eventTypes: ["TW"] },
  NA_TW: { regions: ["NA"], eventTypes: ["TW"] },
  EU_TW: { regions: ["EU"], eventTypes: ["TW"] },
  ALL_TW: { regions: ["SG", "NA", "EU"], eventTypes: ["TW"] },
  ALL_FW: { regions: ["SG", "NA", "EU"], eventTypes: ["FW"] },
  ALL_DW: { regions: ["SG", "NA", "EU"], eventTypes: ["DW"] },
  ALL_O: { regions: ["SG", "NA", "EU"], eventTypes: ["O"] },
  ALL_MS: { regions: ["SG", "NA", "EU"], eventTypes: ["MS"] },
  ALL_STORE: { regions: ["SG", "NA", "EU"], eventTypes: ["STORE"] },
};

function toWords(mode: "single" | "multiple", singleWord: string, multiWords: string) {
  if (mode === "single") {
    const value = singleWord.trim().replace(/\s+/g, "");
    return value ? [value] : [];
  }

  return Array.from(
    new Set(
      multiWords
        .split(/\r?\n/)
        .map((item) => item.trim().replace(/\s+/g, ""))
        .filter(Boolean),
    ),
  );
}

export function PfnAssetsFinder() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");

  const [mode, setMode] = useState<"single" | "multiple">("single");
  const [singleWord, setSingleWord] = useState("");
  const [multipleWords, setMultipleWords] = useState("VacationRing\nHeartRing");
  const [selectedRegions, setSelectedRegions] = useState<Region[]>(["SG", "NA", "EU"]);
  const [selectedTypes, setSelectedTypes] = useState<EventType[]>(["TW", "FW", "DW", "O", "MS", "STORE"]);
  const [numberFrom, setNumberFrom] = useState(1);
  const [numberTo, setNumberTo] = useState(7);
  const [linkCheckEnabled, setLinkCheckEnabled] = useState(true);
  const [linkFormat, setLinkFormat] = useState<"all" | "tabOnly">("all");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<LinkItem[]>([]);
  const [copied, setCopied] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [checkingMessage, setCheckingMessage] = useState("");
  const [checkingProgress, setCheckingProgress] = useState(0);
  const [checkingStartedAt, setCheckingStartedAt] = useState<number | null>(null);
  const [generatedCount, setGeneratedCount] = useState(0);
  const [skippedByFormatCount, setSkippedByFormatCount] = useState(0);
  const [uncheckedCount, setUncheckedCount] = useState(0);
  const [checkDurationMs, setCheckDurationMs] = useState(0);
  const [totalDurationMs, setTotalDurationMs] = useState(0);

  const generateAbortRef = useRef<AbortController | null>(null);

  const wordsPreview = useMemo(() => toWords(mode, singleWord, multipleWords), [mode, singleWord, multipleWords]);
  const visibleResults = useMemo(
    () => results.filter((item) => (typeof item.check?.ok === "boolean" ? item.check.ok : true)),
    [results],
  );

  function formatSeconds(ms: number) {
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function waitForNextPoll(signal: AbortSignal, ms = 900) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const timeout = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  useEffect(() => {
    return () => {
      generateAbortRef.current?.abort();
    };
  }, []);

  function resetResults() {
    setResults([]);
    setCopied(false);
    setErrorText("");
    setCheckingMessage("");
    setCheckingProgress(0);
    setCheckingStartedAt(null);
    setGeneratedCount(0);
    setSkippedByFormatCount(0);
    setUncheckedCount(0);
    setCheckDurationMs(0);
    setTotalDurationMs(0);
  }

  async function checkStatus() {
    const res = await fetch("/api/public/app/status", { credentials: "include" });
    const data = (await res.json()) as { authenticated: boolean };
    setLoggedIn(Boolean(data.authenticated));
  }

  useEffect(() => {
    void checkStatus();
  }, []);

  async function handleLogin() {
    setLoginLoading(true);
    setLoginError("");

    try {
      const res = await fetch("/api/public/app/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setLoginError(data.error ?? "Unable to login");
        return;
      }

      setLoggedIn(true);
      setPassword("");
    } catch {
      setLoginError("Network error while logging in.");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/public/app/logout", { method: "POST", credentials: "include" });
    setLoggedIn(false);
  }

  function toggleRegion(region: Region) {
    setSelectedRegions((prev) =>
      prev.includes(region) ? prev.filter((item) => item !== region) : [...prev, region],
    );
  }

  function toggleType(eventType: EventType) {
    setSelectedTypes((prev) =>
      prev.includes(eventType) ? prev.filter((item) => item !== eventType) : [...prev, eventType],
    );
  }

  async function generate() {
    const words = toWords(mode, singleWord, multipleWords);
    if (words.length === 0) {
      setErrorText("Add at least one word.");
      return;
    }
    if (selectedRegions.length === 0) {
      setErrorText("Select at least one region.");
      return;
    }
    if (selectedTypes.length === 0) {
      setErrorText("Select at least one format.");
      return;
    }
    if (numberFrom > numberTo) {
      setErrorText("Start number must be <= end number.");
      return;
    }

    setErrorText("");
    setGeneratedCount(0);
    setCheckDurationMs(0);
    setTotalDurationMs(0);
    const startedAt = Date.now();
    setCheckingStartedAt(startedAt);
    setCheckingMessage(linkCheckEnabled ? "Starting live checking..." : "Generating links...");
    setCheckingProgress(8);
    setLoading(true);

    const controller = new AbortController();
    generateAbortRef.current = controller;
    const requestPayload = {
      linkFormat,
      checkLinks: linkCheckEnabled,
      input: {
        words,
        regions: selectedRegions,
        eventTypes: selectedTypes,
        numberRange: { from: numberFrom, to: numberTo },
      },
    };

    const applyResult = (data: {
      links?: LinkItem[];
      generatedCount?: number;
      skippedByFormatCount?: number;
      uncheckedCount?: number;
      checkDurationMs?: number;
      totalDurationMs?: number;
    }) => {
      const links = data.links ?? [];
      setResults(links);
      setGeneratedCount(data.generatedCount ?? links.length);
      setSkippedByFormatCount(data.skippedByFormatCount ?? 0);
      setUncheckedCount(data.uncheckedCount ?? 0);
      setCheckDurationMs(data.checkDurationMs ?? 0);
      setTotalDurationMs(data.totalDurationMs ?? 0);
      const checkedCount = links.length;
      const workingCount = links.filter((item) => item.check?.ok).length;
      setCheckingProgress(100);
      setCheckingMessage(
        `Checked ${checkedCount} links in ${formatSeconds(data.checkDurationMs ?? 0)} · Working ${workingCount} · Skipped ${data.skippedByFormatCount ?? 0} · Not checked ${data.uncheckedCount ?? 0}`,
      );
      window.setTimeout(() => {
        setCheckingMessage("");
        setCheckingProgress(0);
        setCheckingStartedAt(null);
      }, 1200);
    };

    const fallbackSyncRun = async () => {
      const syncRes = await fetch("/api/public/app/generate-links", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestPayload, mode: "sync" }),
      });

      const syncData = (await syncRes.json()) as {
        ok: boolean;
        error?: string;
        links?: LinkItem[];
        generatedCount?: number;
        skippedByFormatCount?: number;
        uncheckedCount?: number;
        checkDurationMs?: number;
        totalDurationMs?: number;
      };

      if (!syncRes.ok || !syncData.ok) {
        setCheckingProgress(0);
        setCheckingMessage("");
        setCheckingStartedAt(null);
        setErrorText(syncData.error ?? "Generation failed");
        return;
      }

      applyResult(syncData);
    };

    try {
      const startRes = await fetch("/api/public/app/generate-links", {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestPayload, mode: "async" }),
      });

      const startData = (await startRes.json()) as {
        ok: boolean;
        error?: string;
        async?: boolean;
        jobId?: string;
        status?: "pending" | "processing" | "done" | "failed";
        processed?: number;
        total?: number;
        elapsedMs?: number;
        estimatedRemainingMs?: number;
        links?: LinkItem[];
        generatedCount?: number;
        skippedByFormatCount?: number;
        uncheckedCount?: number;
        checkDurationMs?: number;
        totalDurationMs?: number;
      };

      if (!startRes.ok || !startData.ok) {
        if (startRes.status === 401) {
          setLoggedIn(false);
          setErrorText("Session expired. Login again.");
        } else {
          setErrorText(startData.error ?? "Generation failed");
        }
        setCheckingProgress(0);
        setCheckingMessage("");
        setCheckingStartedAt(null);
        return;
      }

      if (startData.async && startData.jobId) {
        setCheckingProgress(10);

        while (true) {
          await waitForNextPoll(controller.signal);

          const statusRes = await fetch(`/api/public/app/generate-links?jobId=${encodeURIComponent(startData.jobId)}`, {
            credentials: "include",
            signal: controller.signal,
          });

          const statusData = (await statusRes.json()) as {
            ok: boolean;
            error?: string;
            status?: "pending" | "processing" | "done" | "failed";
            processed?: number;
            total?: number;
            elapsedMs?: number;
            estimatedRemainingMs?: number;
            links?: LinkItem[];
            generatedCount?: number;
            skippedByFormatCount?: number;
            uncheckedCount?: number;
            checkDurationMs?: number;
            totalDurationMs?: number;
          };

          const total = statusData.total ?? 0;
          const processed = statusData.processed ?? 0;
          const progress = total > 0 ? Math.max(10, Math.min(96, Math.round((processed / total) * 100))) : 12;
          setCheckingProgress(progress);
          const statusLabel =
            statusData.status === "pending" && total === 0
              ? "Preparing links..."
              : `Checked ${processed}/${total || "..."} · Elapsed ${formatSeconds(statusData.elapsedMs ?? Date.now() - startedAt)} · ETA ${formatSeconds(statusData.estimatedRemainingMs ?? 0)}`;
          setCheckingMessage(statusLabel);

          if (statusRes.status === 401) {
            setLoggedIn(false);
            setCheckingProgress(0);
            setCheckingMessage("");
            setCheckingStartedAt(null);
            setErrorText("Session expired. Login again.");
            return;
          }

          if (statusRes.status === 404 && statusData.error?.toLowerCase().includes("run not found")) {
            setCheckingMessage("Live mode not available here, switching to stable run...");
            setCheckingProgress(15);
            await fallbackSyncRun();
            return;
          }

          if (statusData.status === "failed" || !statusRes.ok) {
            setCheckingProgress(0);
            setCheckingMessage("");
            setCheckingStartedAt(null);
            setErrorText(statusData.error ?? "Generation failed");
            return;
          }

          if (statusData.status === "done" && statusData.ok) {
            applyResult(statusData);
            return;
          }
        }
      }

      applyResult(startData);
    } catch {
      const wasCancelled = controller.signal.aborted;
      if (wasCancelled) {
        setCheckingProgress(0);
        setCheckingMessage("Generation cancelled.");
        setCheckingStartedAt(null);
        return;
      }
      setCheckingProgress(0);
      setCheckingMessage("");
      setCheckingStartedAt(null);
      setErrorText("Network error while generating links.");
    } finally {
      generateAbortRef.current = null;
      setLoading(false);
    }
  }

  function cancelGenerate() {
    generateAbortRef.current?.abort();
  }

  async function copyAll() {
    const text = visibleResults.map((item) => item.url).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function applyPreset(key: keyof typeof PRESETS) {
    const preset = PRESETS[key];
    setSelectedRegions(preset.regions);
    setSelectedTypes(preset.eventTypes);
  }

  if (!loggedIn) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center px-4 py-8">
        <Card className="surface-panel scanlines w-full rounded-lg border-border/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl text-foreground">
              <Shield className="h-6 w-6 text-primary" />
              Enter Access Password
            </CardTitle>
            <CardDescription>Protected access required for the finder.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter website password"
            />
            {loginError ? <p className="text-sm text-destructive">{loginError}</p> : null}
            <Button onClick={handleLogin} disabled={loginLoading} className="w-full">
              {loginLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              Unlock Finder
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="ff-title text-3xl font-semibold tracking-tight text-foreground md:text-4xl">FF Assets Finder</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => applyPreset("ALL")}>
            <Sparkles className="h-4 w-4" />
            All Links
          </Button>
          <Button variant="outline" onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        <Card className="surface-panel rounded-lg border-border/60 soft-enter">
          <CardHeader>
            <CardTitle>Generator Controls</CardTitle>
            <CardDescription>Choose word mode, formats, regions, and number range 1-7.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Tabs value={mode} onValueChange={(value) => setMode(value as "single" | "multiple")}>
              <TabsList>
                <TabsTrigger value="single">Single Word</TabsTrigger>
                <TabsTrigger value="multiple">Multiple Words</TabsTrigger>
              </TabsList>
              <TabsContent value="single" className="space-y-2">
                <Input
                  value={singleWord}
                  onChange={(event) => setSingleWord(event.target.value)}
                  placeholder="e.g. VacationRing"
                />
              </TabsContent>
              <TabsContent value="multiple" className="space-y-2">
                <textarea
                  className="min-h-36 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none ring-ring focus-visible:ring-2"
                  value={multipleWords}
                  onChange={(event) => setMultipleWords(event.target.value)}
                  placeholder="One word per line"
                />
              </TabsContent>
            </Tabs>

            <div className="space-y-2">
              <p className="text-sm font-medium">Quick Filter Presets</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => applyPreset("SG_ALL")}>All Types (SG)</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("NA_ALL")}>All Types (NA)</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("EU_ALL")}>All Types (EU)</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("SG_TW")}>Check Only TW (SG)</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("NA_TW")}>Check Only TW (NA)</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("EU_TW")}>Check Only TW (EU)</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("ALL_TW")}>Check All Regions TW</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("ALL_FW")}>Check All Regions FW</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("ALL_DW")}>Check All Regions DW</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("ALL_O")}>Check All Regions O</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("ALL_MS")}>Check All Regions MS</Button>
                <Button variant="outline" size="sm" onClick={() => applyPreset("ALL_STORE")}>Check All Regions STORE</Button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm font-medium">Regions</p>
                <div className="space-y-2">
                  {REGION_OPTIONS.map((region) => (
                    <label key={region.value} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedRegions.includes(region.value)}
                        onChange={() => toggleRegion(region.value)}
                      />
                      {region.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Formats</p>
                <div className="space-y-2">
                  {EVENT_OPTIONS.map((option) => (
                    <label key={option.value} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedTypes.includes(option.value)}
                        onChange={() => toggleType(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Number From</p>
                <Input
                  type="number"
                  min={1}
                  max={7}
                  value={numberFrom}
                  onChange={(event) => setNumberFrom(Number(event.target.value || 1))}
                />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Number To</p>
                <Input
                  type="number"
                  min={1}
                  max={7}
                  value={numberTo}
                  onChange={(event) => setNumberTo(Number(event.target.value || 7))}
                />
              </div>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={linkCheckEnabled}
                  onChange={(event) => setLinkCheckEnabled(event.target.checked)}
                />
                Check live links
              </label>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Check Format</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={linkFormat === "all" ? "default" : "outline"}
                  onClick={() => setLinkFormat("all")}
                >
                  All Formats
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={linkFormat === "tabOnly" ? "default" : "outline"}
                  onClick={() => setLinkFormat("tabOnly")}
                >
                  TAB Only
                </Button>
              </div>
            </div>

            {errorText ? <p className="text-sm text-destructive">{errorText}</p> : null}

            <Button onClick={generate} disabled={loading} className="w-full glow-outline">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate Links
            </Button>
            <Button onClick={cancelGenerate} disabled={!loading} variant="outline" className="w-full">
              Cancel Generate
            </Button>
          </CardContent>
        </Card>

        <Card className="surface-panel rounded-lg border-border/60 soft-enter">
          <CardHeader>
            <CardTitle>Result Snapshot</CardTitle>
            <CardDescription>
              Words: {wordsPreview.length} · Working Results: {visibleResults.length}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button variant="secondary" onClick={copyAll} disabled={visibleResults.length === 0} className="w-full">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy Working Links"}
            </Button>
            <Button variant="outline" onClick={resetResults} disabled={results.length === 0} className="w-full">
              Reset Results
            </Button>
            {checkingProgress > 0 ? <Progress value={checkingProgress} /> : null}
            {checkingMessage ? <p className="text-xs text-primary">{checkingMessage}</p> : null}
            {checkingStartedAt && loading ? (
              <p className="text-xs text-muted-foreground">
                Current run time: {formatSeconds(Date.now() - checkingStartedAt)}
              </p>
            ) : null}
            {generatedCount > 0 ? (
              <p className="text-xs text-muted-foreground">
                Generated: {generatedCount} · Checked: {visibleResults.length} working · Skipped: {skippedByFormatCount} · Not checked: {uncheckedCount} · Check time: {formatSeconds(checkDurationMs)} · Total: {formatSeconds(totalDurationMs)}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">Current filter: {linkFormat === "tabOnly" ? "TAB format only" : "All formats"}</p>
            <p className="text-xs text-muted-foreground">
              Previews and status are shown below. Green = reachable.
            </p>
          </CardContent>
        </Card>
      </div>

      <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleResults.map((item) => (
          <Card key={item.id} className="surface-panel rounded-lg border-border/60">
            <CardHeader className="space-y-1 pb-3">
              <CardTitle className="text-base">
                {item.region} · {item.eventType} · {item.label}
              </CardTitle>
              <CardDescription>
                Word: {item.word} · Number: {item.number}
                {item.templateWord ? ` · Template: ${item.templateWord}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <img
                src={item.url}
                alt={`${item.region} ${item.eventType} ${item.label}`}
                loading="lazy"
                className="h-56 w-full rounded-md border border-border bg-muted/30 p-1 object-contain"
              />
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="block break-all text-xs text-primary hover:underline"
              >
                {item.url}
              </a>
              <div className="text-xs text-muted-foreground">
                Status: {item.check.ok ? "Reachable" : "Not reachable"}
                {item.check.status ? ` (${item.check.status})` : ""}
              </div>
            </CardContent>
          </Card>
        ))}
        {results.length > 0 && visibleResults.length === 0 ? (
          <Card className="surface-panel rounded-lg border-border/60 md:col-span-2 xl:col-span-3">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No working links found for this run.
            </CardContent>
          </Card>
        ) : null}
      </section>

      <footer className="py-8 text-center">
        <p className="ff-credit text-xl font-semibold md:text-2xl">©️LEAKS OF FF</p>
      </footer>
    </main>
  );
}
