import type { SafetyReviewBody } from "@schlessera/brain-ui-sdk/protocol";
import type { Principal } from "../../src/db/principals";
import type { GovernanceWrites } from "../../src/governance/event-writes";
import type { OwnerSafetyReviews } from "../../src/governance/owner-safety-reviews";

/** Fill the real owner service's pending quota while holding only its lowest
 * preparation RPC. The DB writer remains available to publication and reads. */
export async function holdOwnerReviews(host: { reviews: OwnerSafetyReviews; writes: GovernanceWrites; principal: Principal }, body: SafetyReviewBody) {
  const released = Promise.withResolvers<void>(), original = host.writes.safetyPrepareReview;
  let entered = 0;
  host.writes.safetyPrepareReview = async (...args) => { entered++; await released.promise; return original(...args); };
  const pending = Array.from({ length: 32 }, () => host.reviews.review(host.principal,body,null));
  host.writes.safetyPrepareReview = original;
  const drain = async () => {
    released.resolve();
    const results = await Promise.allSettled(pending);
    const errors = results.filter(result=>result.status==="rejected").map(result=>result.reason);
    if (errors.length) throw new AggregateError(errors,"Held owner reviews failed to drain");
  };
  if (entered !== 32) { await drain(); throw new Error(`Expected 32 admitted owner reviews, got ${entered}`); }
  return { close:drain };
}
