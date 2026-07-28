import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import crypto from "node:crypto";
import { checkLinks, generateLinks, generateLinksInputSchema } from "@/lib/assets.server";
import { inspectSessionFromRequest, logSessionDebug } from "@/lib/session.server";
import { jsonResponse } from "@/lib/http.server";

const schema = z.object({
  input: generateLinksInputSchema,
  checkLinks: z.boolean().default(true),
  linkFormat: z.enum(["all", "tabOnly"]).default("all"),
  mode: z.enum(["sync", "async"]).default("sync"),
});

type LinkResult = Awaited<ReturnType<typeof generateLinks>>["links"][number] & {
  check: { url: string; ok: boolean; status: number | null };
};

type GenerateJob = {
  id: string;
  createdAt: number;
  expiresAt: number;
  total: number;
  processed: number;
  status: "pending" | "processing" | "done" | "failed";
  error?: string;
  result?: {
    links: LinkResult[];
    generatedCount: number;
    skippedByFormatCount: number;
    uncheckedCount: number;
    checkDurationMs: number;
    totalDurationMs: number;
  };
};

const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map<string, GenerateJob>();

function cleanupJobs() {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (job.expiresAt <= now) {
      jobs.delete(jobId);
    }
  }
}

async function runGeneration(input: z.infer<typeof schema>, requestStart: number, onProgress?: (progress: { processed: number; total: number }) => void) {
  const generated = await generateLinks(input.input, { linkFormat: input.linkFormat });
  const filteredLinks = generated.links;
  const skippedByFormatCount = generated.skippedByFormatCount ?? 0;

  onProgress?.({ processed: 0, total: filteredLinks.length });

  if (!input.checkLinks) {
    const noCheckLinks = filteredLinks.map((item) => ({
      ...item,
      check: { url: item.url, ok: true, status: null },
    }));

    return {
      links: noCheckLinks,
      generatedCount: filteredLinks.length,
      skippedByFormatCount,
      uncheckedCount: noCheckLinks.length,
      checkDurationMs: 0,
      totalDurationMs: Date.now() - requestStart,
    };
  }

  const checkStart = Date.now();
  const checked = await checkLinks(filteredLinks.map((item) => item.url), { onProgress });
  const checkDurationMs = Date.now() - checkStart;
  const statusByUrl = new Map(checked.map((item) => [item.url, item]));

  const merged = filteredLinks.map((item) => ({
    ...item,
    check: statusByUrl.get(item.url) ?? { url: item.url, ok: false, status: null },
  }));

  return {
    links: merged,
    generatedCount: filteredLinks.length,
    skippedByFormatCount,
    uncheckedCount: 0,
    checkDurationMs,
    totalDurationMs: Date.now() - requestStart,
  };
}

export const Route = createFileRoute("/api/public/app/generate-links")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        cleanupJobs();
        const requestStart = Date.now();
        const sessionDebug = inspectSessionFromRequest(request, "main");
        if (!sessionDebug.authenticated) {
          logSessionDebug(request, "app/generate-links unauthorized", sessionDebug);
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
        }

        const parsed = schema.safeParse(await request.json().catch(() => ({})));
        if (!parsed.success) {
          return jsonResponse({ ok: false, error: "Invalid request payload." }, 400);
        }

        if (parsed.data.mode === "async") {
          const jobId = crypto.randomUUID();
          const job: GenerateJob = {
            id: jobId,
            createdAt: Date.now(),
            expiresAt: Date.now() + JOB_TTL_MS,
            total: 0,
            processed: 0,
            status: "pending",
          };
          jobs.set(jobId, job);

          void runGeneration(parsed.data, requestStart, (progress) => {
            const active = jobs.get(jobId);
            if (!active) return;
            active.status = "processing";
            active.total = progress.total;
            active.processed = progress.processed;
            active.expiresAt = Date.now() + JOB_TTL_MS;
            jobs.set(jobId, active);
          })
            .then((result) => {
              const active = jobs.get(jobId);
              if (!active) return;
              active.status = "done";
              active.result = result;
              active.total = result.generatedCount;
              active.processed = result.generatedCount;
              active.expiresAt = Date.now() + JOB_TTL_MS;
              jobs.set(jobId, active);
            })
            .catch((error) => {
              const active = jobs.get(jobId);
              if (!active) return;
              active.status = "failed";
              active.error = error instanceof Error ? error.message : "Generation failed";
              active.expiresAt = Date.now() + JOB_TTL_MS;
              jobs.set(jobId, active);
            });

          return jsonResponse({
            ok: true,
            async: true,
            jobId,
          });
        }

        const result = await runGeneration(parsed.data, requestStart);
        return jsonResponse({ ok: true, ...result });
      },
      GET: async ({ request }) => {
        cleanupJobs();
        const sessionDebug = inspectSessionFromRequest(request, "main");
        if (!sessionDebug.authenticated) {
          logSessionDebug(request, "app/generate-links status unauthorized", sessionDebug);
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
        }

        const url = new URL(request.url);
        const jobId = (url.searchParams.get("jobId") ?? "").trim();
        if (!jobId) {
          return jsonResponse({ ok: false, error: "Missing jobId." }, 400);
        }

        const job = jobs.get(jobId);
        if (!job) {
          return jsonResponse({ ok: false, error: "Run not found or expired." }, 404);
        }

        const elapsedMs = Date.now() - job.createdAt;
        const averagePerItem = job.processed > 0 ? elapsedMs / job.processed : 0;
        const estimatedRemainingMs =
          job.total > 0 && job.processed > 0 && job.processed < job.total
            ? Math.max(0, Math.round((job.total - job.processed) * averagePerItem))
            : 0;

        if (job.status === "done" && job.result) {
          return jsonResponse({
            ok: true,
            status: "done",
            processed: job.processed,
            total: job.total,
            elapsedMs,
            estimatedRemainingMs: 0,
            ...job.result,
          });
        }

        if (job.status === "failed") {
          return jsonResponse({
            ok: false,
            status: "failed",
            processed: job.processed,
            total: job.total,
            elapsedMs,
            estimatedRemainingMs,
            error: job.error ?? "Generation failed",
          }, 500);
        }

        return jsonResponse({
          ok: true,
          status: job.status,
          processed: job.processed,
          total: job.total,
          elapsedMs,
          estimatedRemainingMs,
        });
      },
    },
  },
});
