import crypto from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const regionSchema = z.enum(["SG", "NA", "EU"]);
export const eventTypeSchema = z.enum(["TW", "FW", "DW", "O", "MS", "STORE"]);

export const generateLinksInputSchema = z.object({
  words: z.array(z.string().trim().min(1).max(80)).min(1).max(1200),
  regions: z.array(regionSchema).min(1),
  eventTypes: z.array(eventTypeSchema).min(1),
  numberRange: z.object({
    from: z.number().int().min(1).max(7),
    to: z.number().int().min(1).max(7),
  }),
});

export type GenerateLinksInput = z.infer<typeof generateLinksInputSchema>;

export type GenerateLinkFormat = "all" | "tabOnly";

function isTabPattern(input: { label: string; pattern: string }) {
  const label = input.label.toLowerCase();
  const pattern = input.pattern.toLowerCase();
  return /\btab\b/.test(label) || /\btab\b/.test(pattern) || /\/tab(?:[\/_\-.\d]|$)/.test(pattern);
}

type PatternRow = {
  id: string;
  region: string;
  event_type: string;
  label: string;
  pattern: string;
  sort_order: number;
  is_active: boolean;
};

type TemplateRow = {
  event_type: string;
  template_word: string;
  is_active: boolean;
};

const LINK_META_CACHE_TTL_MS = 60_000;

let linkMetaCache:
  | {
      expiresAt: number;
      patterns: PatternRow[];
      templates: TemplateRow[];
    }
  | null = null;

function sanitizeWord(value: string) {
  return value.trim().replace(/\s+/g, "");
}

function hashCode(code: string) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function getActiveLinkMeta() {
  const now = Date.now();
  if (linkMetaCache && linkMetaCache.expiresAt > now) {
    return linkMetaCache;
  }

  const [patternsRes, templatesRes] = await Promise.all([
    supabaseAdmin
      .from("asset_link_patterns")
      .select("id, region, event_type, label, pattern, sort_order, is_active")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("sg_template_words")
      .select("event_type, template_word, is_active")
      .eq("is_active", true),
  ]);

  if (patternsRes.error) throw new Error(patternsRes.error.message);
  if (templatesRes.error) throw new Error(templatesRes.error.message);

  linkMetaCache = {
    expiresAt: now + LINK_META_CACHE_TTL_MS,
    patterns: (patternsRes.data as PatternRow[]) ?? [],
    templates: (templatesRes.data as TemplateRow[]) ?? [],
  };

  return linkMetaCache;
}

export function createRandomAccessCode(length = 6) {
  const charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let index = 0; index < length; index += 1) {
    const random = crypto.randomInt(0, charset.length);
    result += charset[random];
  }
  return result;
}

export async function isPasswordValid(
  scope: "main" | "admin",
  password: string,
): Promise<{ valid: boolean; expiresAt: Date }> {
  const settingsKey = scope === "admin" ? "admin_access" : "main_access";

  const [{ data: setting }, { data: codeMatch }] = await Promise.all([
    supabaseAdmin.from("app_settings").select("value_json").eq("key", settingsKey).maybeSingle(),
    supabaseAdmin
      .from("access_codes")
      .select("id, expires_at")
      .eq("scope", scope)
      .eq("code_hash", hashCode(password))
      .eq("revoked", false)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle(),
  ]);

  const configuredPassword =
    setting?.value_json && typeof setting.value_json === "object" && "password" in setting.value_json
      ? String(setting.value_json.password ?? "")
      : "";

  if (password === configuredPassword && configuredPassword.length > 0) {
    return {
      valid: true,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    };
  }

  if (codeMatch) {
    return {
      valid: true,
      expiresAt: new Date(codeMatch.expires_at),
    };
  }

  return { valid: false, expiresAt: new Date(0) };
}

export async function getAdminConfig() {
  const [settingsRes, patternsRes, templatesRes] = await Promise.all([
    supabaseAdmin.from("app_settings").select("key, value_json"),
    supabaseAdmin
      .from("asset_link_patterns")
      .select("id, region, event_type, label, pattern, sort_order, is_active")
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("sg_template_words")
      .select("id, event_type, template_word, is_active")
      .order("event_type", { ascending: true })
      .order("template_word", { ascending: true }),
  ]);

  if (settingsRes.error) throw new Error(settingsRes.error.message);
  if (patternsRes.error) throw new Error(patternsRes.error.message);
  if (templatesRes.error) throw new Error(templatesRes.error.message);

  const settings = Object.fromEntries(
    (settingsRes.data ?? []).map((item) => [item.key, item.value_json]),
  );

  return {
    settings,
    patterns: patternsRes.data ?? [],
    templates: templatesRes.data ?? [],
  };
}

export async function saveAdminConfig(input: {
  mainPassword: string;
  adminPassword: string;
  patterns: Array<{
    id?: string;
    region: "SG" | "NA" | "EU";
    event_type: "TW" | "FW" | "DW" | "O" | "MS" | "STORE";
    label: string;
    pattern: string;
    sort_order: number;
    is_active: boolean;
  }>;
  templates: Array<{
    id?: string;
    event_type: "TW" | "FW" | "DW" | "O" | "MS";
    template_word: string;
    is_active: boolean;
  }>;
}) {
  const settingsPayload = [
    { key: "main_access", value_json: { password: input.mainPassword } },
    { key: "admin_access", value_json: { password: input.adminPassword } },
  ];

  const cleanPatterns = input.patterns
    .map((item) => ({
      id: item.id,
      region: item.region,
      event_type: item.event_type,
      label: item.label.trim(),
      pattern: item.pattern.trim(),
      sort_order: item.sort_order,
      is_active: item.is_active,
    }))
    .filter((item) => item.label.length > 0 && item.pattern.length > 0);

  const cleanTemplates = input.templates
    .map((item) => ({
      id: item.id,
      event_type: item.event_type,
      template_word: sanitizeWord(item.template_word),
      is_active: item.is_active,
    }))
    .filter((item) => item.template_word.length > 0);

  const { error: settingsError } = await supabaseAdmin
    .from("app_settings")
    .upsert(settingsPayload, { onConflict: "key" });
  if (settingsError) throw new Error(settingsError.message);

  const { error: deletePatternsError } = await supabaseAdmin
    .from("asset_link_patterns")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (deletePatternsError) throw new Error(deletePatternsError.message);

  if (cleanPatterns.length > 0) {
    const { error: insertPatternsError } = await supabaseAdmin
      .from("asset_link_patterns")
      .insert(cleanPatterns.map(({ id: _unused, ...rest }) => rest));
    if (insertPatternsError) throw new Error(insertPatternsError.message);
  }

  const { error: deleteTemplatesError } = await supabaseAdmin
    .from("sg_template_words")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000");
  if (deleteTemplatesError) throw new Error(deleteTemplatesError.message);

  if (cleanTemplates.length > 0) {
    const { error: insertTemplatesError } = await supabaseAdmin
      .from("sg_template_words")
      .insert(cleanTemplates.map(({ id: _unused, ...rest }) => rest));
    if (insertTemplatesError) throw new Error(insertTemplatesError.message);
  }
}

export async function generateAccessCode(input: {
  scope: "main" | "admin";
  durationMs: number;
}) {
  const rawCode = createRandomAccessCode(6);
  const expiresAt = new Date(Date.now() + input.durationMs);

  const { error } = await supabaseAdmin.from("access_codes").insert({
    code_hash: hashCode(rawCode),
    scope: input.scope,
    expires_at: expiresAt.toISOString(),
  });

  if (error) throw new Error(error.message);

  return {
    code: rawCode,
    scope: input.scope,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function generateLinks(input: GenerateLinksInput, options?: { linkFormat?: GenerateLinkFormat }) {
  const normalizedWords = Array.from(
    new Set(input.words.map(sanitizeWord).filter((value) => value.length > 0)),
  );

  const linkMeta = await getActiveLinkMeta();
  const regionSet = new Set(input.regions);
  const eventSet = new Set(input.eventTypes);
  const patterns = linkMeta.patterns.filter(
    (row) =>
      regionSet.has(row.region as GenerateLinksInput["regions"][number]) &&
      eventSet.has(row.event_type as GenerateLinksInput["eventTypes"][number]),
  );

  const filteredPatterns =
    options?.linkFormat === "tabOnly"
      ? patterns.filter((row) => isTabPattern({ label: row.label, pattern: row.pattern }))
      : patterns;

  const needsTemplateByEvent = new Set<string>();
  filteredPatterns.forEach((patternRow) => {
    if (patternRow.pattern.includes("(Template)") && patternRow.region === "SG") {
      needsTemplateByEvent.add(patternRow.event_type);
    }
  });

  const templateRows =
    needsTemplateByEvent.size > 0
      ? linkMeta.templates.filter((row) => needsTemplateByEvent.has(row.event_type))
      : [];

  const templatesByEvent = templateRows.reduce<Record<string, string[]>>((acc, row) => {
    if (!acc[row.event_type]) acc[row.event_type] = [];
    acc[row.event_type].push(row.template_word);
    return acc;
  }, {});

  const links: Array<{
    id: string;
    region: string;
    eventType: string;
    label: string;
    word: string;
    number: number;
    templateWord: string | null;
    url: string;
  }> = [];

  const seen = new Set<string>();

  filteredPatterns.forEach((patternRow) => {
    const numbers: number[] = [];
    for (let num = input.numberRange.from; num <= input.numberRange.to; num += 1) numbers.push(num);

    const templateWords =
      patternRow.region === "SG" && patternRow.pattern.includes("(Template)")
        ? templatesByEvent[patternRow.event_type] && templatesByEvent[patternRow.event_type].length > 0
          ? templatesByEvent[patternRow.event_type]
          : ["Template"]
        : [""];

    normalizedWords.forEach((word) => {
      templateWords.forEach((templateWord) => {
        numbers.forEach((number) => {
          const url = patternRow.pattern
            .replaceAll("(Template)", templateWord)
            .replaceAll("(Number)", String(number))
            .replaceAll("(Word)", word);

          if (seen.has(url)) return;
          seen.add(url);

          links.push({
            id: `${patternRow.id}-${word}-${number}-${templateWord}`,
            region: patternRow.region,
            eventType: patternRow.event_type,
            label: patternRow.label,
            word,
            number,
            templateWord: templateWord || null,
            url,
          });
        });
      });
    });
  });

  return { links };
}

export async function checkLinks(
  urls: string[],
  options?: { onProgress?: (progress: { processed: number; total: number }) => void },
) {
  const sanitizedUrls = Array.from(new Set(urls.filter((url) => url.startsWith("https://"))));

  if (sanitizedUrls.length === 0) {
    options?.onProgress?.({ processed: 0, total: 0 });
    return [];
  }

  const timeoutMs = 1200;
  const workerLimit = Math.min(220, Math.max(36, Math.ceil(sanitizedUrls.length / 8)));
  const retryAttempts = 0;
  const results: Array<{ url: string; ok: boolean; status: number | null }> = [];
  const total = sanitizedUrls.length;
  let processed = 0;

  let cursor = 0;

  async function fetchWithTimeout(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        method: "GET",
        headers: {
          Range: "bytes=0-0",
        },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkOneUrl(url: string) {
    for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url);
        const isReachable =
          response.ok ||
          response.status === 206 ||
          response.status === 403 ||
          response.status === 429;
        return { url, ok: isReachable, status: response.status };
      } catch {
        if (attempt === retryAttempts) {
          return { url, ok: false, status: null };
        }
      }
    }

    return { url, ok: false, status: null };
  }

  async function worker() {
    while (cursor < sanitizedUrls.length) {
      const currentIndex = cursor;
      cursor += 1;
      const url = sanitizedUrls[currentIndex];
      results.push(await checkOneUrl(url));
      processed += 1;
      options?.onProgress?.({ processed, total });
    }
  }

  await Promise.all(Array.from({ length: workerLimit }, () => worker()));

  const map = new Map(results.map((item) => [item.url, item]));
  return sanitizedUrls.map((url) => map.get(url) ?? { url, ok: false, status: null });
}
