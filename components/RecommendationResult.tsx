import type { ReactNode } from "react";
import type { RecommendationResponse } from "../lib/recommendation-contract";
import type { Freshness } from "../lib/recommendation/request-lifecycle";

export function RecommendationResult({ recommendation, freshness, pickAction }: {
  recommendation: RecommendationResponse;
  freshness: Freshness;
  pickAction: (id: number) => ReactNode;
}) {
  const kind = recommendation.kind === "augment" ? "Augment" : "Item";
  if (freshness.status === "invalid") return (
    <p className="notice" role="status">{kind} advice is invalid for this game or decision. Request new advice.</p>
  );
  const actionable = freshness.status === "current";
  return (
    <section className="recommendation-panel" aria-live="polite" aria-label={`${kind} recommendation`}>
      <div className="recommendation-title">
        <div>
          <span>{kind.toUpperCase()} ADVICE · {actionable ? "Current" : "Outdated"}</span>
          <h2>{recommendation.primary.name}</h2>
        </div>
        <b className={`confidence confidence-${recommendation.confidence}`}>{recommendation.confidence} confidence</b>
      </div>
      {!actionable ? <p className="notice" role="status">
        {freshness.reason === "live-unverified"
          ? "Live state is unavailable or unverified. Previous advice is preserved; confirm current state before acting."
          : "Game state changed. Previous advice is preserved; request an update before acting."}
      </p> : null}
      <p className="primary-reason">{recommendation.primary.reason}</p>
      {actionable && recommendation.kind === "augment" ? pickAction(recommendation.primary.id) : null}
      {recommendation.alternatives.length ? <div className="recommendation-alternatives">
        {recommendation.alternatives.map(alternative => <article key={alternative.id}>
          <strong>{alternative.name}</strong>
          <p>{alternative.reason}</p>
          {alternative.preferWhen ? <small>Prefer when: {alternative.preferWhen}</small> : null}
          {actionable && recommendation.kind === "augment" ? pickAction(alternative.id) : null}
        </article>)}
      </div> : null}
      {recommendation.buildDirection ? <p className="build-direction"><strong>Direction:</strong> {recommendation.buildDirection}</p> : null}
      {recommendation.warnings.length ? <ul className="recommendation-warnings">
        {recommendation.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul> : null}
    </section>
  );
}
