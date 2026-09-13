export { detectReadFormat, type ReadLayout, type ProjectReadFormat, type SubsystemFormat } from "./format";
export { CompatibilityQueries, type HistoryItem, type V2SpecView, type V2SpecReader, type LegacyHistoryReader, type QueryFailure } from "./query";
// Concrete file composition stays in ./file; importing query contracts does not construct adapters.
