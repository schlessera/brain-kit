/**
 * Safety capability constants in a zod-free leaf, so the protocol module can
 * re-export them without loading the safety schemas. `safety.ts` re-exports
 * them too; a test pins that the literal parses unchanged through
 * `safetyCapabilitiesSchema`.
 */
import type { SafetyCapabilities } from "./safety.js";

export const SESSION_SAFETY_CAPABILITY = "sessionSafetyHistory";
export const SAFETY_READ_CAPABILITIES: SafetyCapabilities = {version:1,read:true,review:false,originRules:false,repositoryRules:false,recipientRules:false,readOnlyReason:"review_unavailable",detectorVersion:1,
  limits:{pageRecords:100,frameBytes:262144,cursorBytes:512,cursorLifetimeMs:300000}};
