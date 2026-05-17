import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
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

function isTabStyleLink(input: { label: string; url: string }) {
  const label = input.label.toLowerCase();
  const url = input.url.toLowerCase();
  return /\btab\b/.test(label) || /\btab\b/.test(url) || /\/tab(?:[\/_\-.\d]|$)/.test(url);
}

export const Route = createFileRoute("/api/public/app/generate-links")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        const generated = await generateLinks(parsed.data.input);
        const filteredLinks =
          parsed.data.linkFormat === "tabOnly"
            ? generated.links.filter((item) => isTabStyleLink({ label: item.label, url: item.url }))
            : generated.links;
        const skippedByFormatCount = generated.links.length - filteredLinks.length;

        if (!parsed.data.checkLinks) {
          const noCheckLinks = filteredLinks.map((item) => ({
            ...item,
            check: { url: item.url, ok: true, status: null },
          }));

          return jsonResponse({
            ok: true,
            links: noCheckLinks,
            generatedCount: filteredLinks.length,
            skippedByFormatCount,
            uncheckedCount: noCheckLinks.length,
            checkDurationMs: 0,
            totalDurationMs: Date.now() - requestStart,
          });
        }

        const checkStart = Date.now();
        const checked = await checkLinks(filteredLinks.map((item) => item.url));
        const checkDurationMs = Date.now() - checkStart;
        const statusByUrl = new Map(checked.map((item) => [item.url, item]));

        const merged = filteredLinks.map((item) => ({
          ...item,
          check: statusByUrl.get(item.url) ?? { url: item.url, ok: false, status: null },
        }));

        return jsonResponse({
          ok: true,
          links: merged,
          generatedCount: filteredLinks.length,
          skippedByFormatCount,
          uncheckedCount: 0,
          checkDurationMs,
          totalDurationMs: Date.now() - requestStart,
        });
      },
      GET: async ({ request }) => {
        const sessionDebug = inspectSessionFromRequest(request, "main");
        if (!sessionDebug.authenticated) {
          logSessionDebug(request, "app/generate-links status unauthorized", sessionDebug);
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
        }
        return jsonResponse(
          {
            ok: false,
            error: "Async status polling is no longer used. Submit generation request directly.",
          },
          410,
        );
      },
    },
  },
});
