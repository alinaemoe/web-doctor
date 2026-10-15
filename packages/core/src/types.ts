import type { z } from "zod";
import type {
  BoxSchema,
  CategorySchema,
  EvidenceSchema,
  ExplanationSchema,
  FixSuggestionSchema,
  IssueGroupSchema,
  IssueSchema,
  NodeSignatureSchema,
  ReportSchema,
  RunSchema,
  RunSettingsSchema,
  RunStatusSchema,
  SeveritySchema,
  StatusChangeSchema,
  StatusSchema,
  UnverifiedReasonSchema,
  VerdictSchema,
  ViewportSchema,
} from "./schemas";

export type Severity = z.infer<typeof SeveritySchema>;
export type Category = z.infer<typeof CategorySchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type Status = z.infer<typeof StatusSchema>;
export type UnverifiedReason = z.infer<typeof UnverifiedReasonSchema>;
export type Box = z.infer<typeof BoxSchema>;
export type NodeSignature = z.infer<typeof NodeSignatureSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Explanation = z.infer<typeof ExplanationSchema>;
export type FixSuggestion = z.infer<typeof FixSuggestionSchema>;
export type StatusChange = z.infer<typeof StatusChangeSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunSettings = z.infer<typeof RunSettingsSchema>;
export type Run = z.infer<typeof RunSchema>;
export type IssueGroup = z.infer<typeof IssueGroupSchema>;
export type Report = z.infer<typeof ReportSchema>;
