import { NextResponse } from "next/server";
import { z } from "zod";

import augmentsSnapshot from "@/data/generated/16.19.1/augments.json";
import championsSnapshot from "@/data/generated/16.19.1/champions.json";
import itemsSnapshot from "@/data/generated/16.19.1/items.json";
import manifest from "@/data/generated/16.19.1/manifest.json";
import type { Augment, Champion, Item } from "@/lib/catalog";
import type { RecommendationApiFailure, RecommendationApiSuccess } from "@/lib/recommendation/api-contract";
import { recommendationApiInputSchema } from "@/lib/recommendation/api-contract";
import {
  configuredRecommendationProvider,
  RecommendationProviderError,
} from "@/lib/recommendation/provider";
import {
  createRecommendationRequest,
  InvalidModelResponseError,
  RecommendationRequestError,
  runRecommendation,
} from "@/lib/recommendation/service";
import { SnapshotNormalizationError } from "@/lib/preprocess-game-state";
import { attemptSchema, requestEvidenceSchema, serverDiagnosticsSchema, type ServerDiagnostics } from "@/lib/diagnostics/schema";

const catalog = {
  champions: championsSnapshot.champions as Champion[],
  augments: augmentsSnapshot.augments as Augment[],
  items: itemsSnapshot.items as Item[],
};
const metadata = {
  patch: manifest.riotDataDragonPatch,
  generatedAt: manifest.generatedAt,
};

function failure(
  status: number,
  code: RecommendationApiFailure["error"]["code"],
  message: string,
  details?: string[],
) {
  return NextResponse.json<RecommendationApiFailure>(
    { ok: false, error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

export async function POST(httpRequest: Request) {
  const started = Date.now();
  let body: unknown;
  try {
    body = await httpRequest.json();
  } catch {
    return failure(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = recommendationApiInputSchema.safeParse(body);
  if (!parsed.success) {
    const correlation = z.object({ diagnosticRequestId: z.string().uuid() }).safeParse(body);
    if (correlation.success) return NextResponse.json<RecommendationApiFailure>({ ok: false,
      error: { code: "INVALID_REQUEST", message: "Recommendation state is malformed." },
      diagnostics: { requestId: correlation.data.diagnosticRequestId, elapsedMs: Date.now() - started, attempts: [], outcome: "INVALID_REQUEST" },
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
    return failure(
      400,
      "INVALID_REQUEST",
      "Recommendation state is malformed.",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const requestId = parsed.data.diagnosticRequestId;
  const diagnostics: ServerDiagnostics | undefined = requestId
    ? { requestId, elapsedMs: 0, attempts: [], outcome: "success" } : undefined;
  function capture(outcome: ServerDiagnostics["outcome"]) {
    if (!diagnostics) return undefined;
    try { return serverDiagnosticsSchema.parse({ ...diagnostics, outcome, elapsedMs: Date.now() - started }); }
    catch { return undefined; }
  }
  function diagnosticFailure(status: number, code: RecommendationApiFailure["error"]["code"], message: string, details?: string[]) {
    return NextResponse.json<RecommendationApiFailure>({ ok: false,
      error: { code, message, ...(details ? { details } : {}) }, diagnostics: capture(code),
    }, { status, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const request = createRecommendationRequest(
      parsed.data.kind,
      parsed.data.state,
      catalog,
      metadata,
      catalog.items,
    );
    if (diagnostics) {
      try { diagnostics.evidence = requestEvidenceSchema.parse(request); } catch { diagnostics.captureIncomplete = true; }
    }
    const provider = configuredRecommendationProvider(diagnostics ? (event) => {
      const safe = attemptSchema.safeParse(event);
      if (safe.success && diagnostics.attempts.length < 2) diagnostics.attempts.push(safe.data);
      else diagnostics.captureIncomplete = true;
    } : undefined);
    if (diagnostics) diagnostics.provider = provider.metadata;
    const result = await runRecommendation(request, provider);
    return NextResponse.json<RecommendationApiSuccess>({
      ok: true,
      recommendation: result.recommendation,
      debug: { request: result.request, provider: result.provider },
      diagnostics: capture("success"),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RecommendationRequestError || error instanceof SnapshotNormalizationError) {
      return diagnosticFailure(400, "INVALID_REQUEST", error.message);
    }
    if (error instanceof InvalidModelResponseError) {
      if (diagnostics) diagnostics.failureClassification = "invalid-recommendation";
      console.error("Mayhem recommendation response rejected", { classification: "invalid-recommendation", issueCount: error.issues.length });
      return diagnosticFailure(
        502,
        "INVALID_MODEL_RESPONSE",
        "The model returned an invalid recommendation. Your state is unchanged; please retry.",
        error.issues,
      );
    }
    if (error instanceof RecommendationProviderError) {
      if (diagnostics) diagnostics.failureClassification = error.classification;
      const notConfigured = error.message.includes("not configured") || error.message.includes("fake recommendation");
      console.error("Mayhem recommendation provider error", { classification: error.classification });
      return diagnosticFailure(
        notConfigured ? 503 : 502,
        notConfigured ? "NOT_CONFIGURED" : "PROVIDER_ERROR",
        error.message,
      );
    }

    // SDK errors can carry request headers/body. Never log the raw exception or game state.
    if (diagnostics) diagnostics.failureClassification = "unexpected-error";
    console.error("Mayhem recommendation request failed", { classification: "unexpected-error" });
    return diagnosticFailure(502, "PROVIDER_ERROR", "The recommendation provider request failed. Please retry.");
  }
}

