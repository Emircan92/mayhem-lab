import { NextResponse } from "next/server";

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
  let body: unknown;
  try {
    body = await httpRequest.json();
  } catch {
    return failure(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }

  const parsed = recommendationApiInputSchema.safeParse(body);
  if (!parsed.success) {
    return failure(
      400,
      "INVALID_REQUEST",
      "Recommendation state is malformed.",
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  try {
    const request = createRecommendationRequest(
      parsed.data.kind,
      parsed.data.state,
      catalog,
      metadata,
      catalog.items,
    );
    const provider = configuredRecommendationProvider();
    const result = await runRecommendation(request, provider);
    return NextResponse.json<RecommendationApiSuccess>({
      ok: true,
      recommendation: result.recommendation,
      debug: { request: result.request, provider: result.provider },
    });
  } catch (error) {
    if (error instanceof RecommendationRequestError || error instanceof SnapshotNormalizationError) {
      return failure(400, "INVALID_REQUEST", error.message);
    }
    if (error instanceof InvalidModelResponseError) {
      console.error("Mayhem recommendation response rejected", { issues: error.issues });
      return failure(
        502,
        "INVALID_MODEL_RESPONSE",
        "The model returned an invalid recommendation. Your state is unchanged; please retry.",
        error.issues,
      );
    }
    if (error instanceof RecommendationProviderError) {
      const notConfigured = error.message.includes("not configured") || error.message.includes("fake recommendation");
      console.error("Mayhem recommendation provider error", { message: error.message });
      return failure(
        notConfigured ? 503 : 502,
        notConfigured ? "NOT_CONFIGURED" : "PROVIDER_ERROR",
        error.message,
      );
    }

    console.error("Mayhem recommendation request failed", error);
    return failure(502, "PROVIDER_ERROR", "The recommendation provider request failed. Please retry.");
  }
}

