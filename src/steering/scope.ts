import { matchesPath, type PathSelector } from "../context/declarations";
import { exact } from "../spec/domain/primitives";
import { steeringPhases, steeringScopeSchema } from "./applicability";
import { distinct, sorted, type SteeringAction, type SteeringEvaluation } from "./resolution-contract";
import type { SteeringInclusionSelector, SteeringScope } from "./types";

type Expression = SteeringScope | SteeringInclusionSelector;
export type SteeringScopeRelation = "equal" | "narrower" | "wider" | "disjoint" | "overlapping-incomparable" | "invalid";
const children = (expression: Expression): readonly Expression[] => expression.kind !== "composite" ? [] :
  "scopes" in expression ? expression.scopes : expression.selectors;

/** Set presentation only. Does not deduplicate, repair, or flatten invalid authored declarations. */
export function orderSteeringExpression<T extends Expression>(expression: T): T {
  if (expression.kind === "composite") return { ...expression,
    ...("scopes" in expression ? { scopes: sorted(expression.scopes.map(orderSteeringExpression)) } :
      { selectors: sorted(expression.selectors.map(orderSteeringExpression)) }),
  } as T;
  if (expression.kind === "phase") return { ...expression, phases: [...expression.phases].sort((a, b) => steeringPhases.indexOf(a) - steeringPhases.indexOf(b)) } as T;
  if (expression.kind === "path") return { ...expression, selectors: sorted(expression.selectors) } as T;
  if (expression.kind === "spec-kind") return { ...expression, kinds: sorted(expression.kinds) } as T;
  if (expression.kind === "task-kind") return { ...expression, kinds: sorted(expression.kinds) } as T;
  return expression;
}
const global = (scope: Expression): boolean => scope.kind === "project-global" || scope.kind === "always";
const insideTree = (path: string, tree: string): boolean => path === tree || path.startsWith(`${tree}/`);
function pathImplies(left: PathSelector, right: PathSelector): boolean {
  if (exact(left, right)) return true;
  // General glob containment, including apparently simple glob trees, is deliberately not inferred.
  return left.kind !== "glob" && right.kind === "tree" && insideTree(left.path, right.path);
}
function pathDisjoint(left: PathSelector, right: PathSelector): boolean {
  if (left.kind === "exact") return !matchesPath(right, left.path);
  if (right.kind === "exact") return !matchesPath(left, right.path);
  if (left.kind === "tree" && right.kind === "tree") return !insideTree(left.path, right.path) && !insideTree(right.path, left.path);
  return false;
}

/** A bounded structural implication proof, not a general boolean/glob theorem prover. */
export function steeringExpressionImplies(left: Expression, right: Expression): boolean {
  if (exact(left, right) || global(right)) return true;
  if (global(left)) return false;
  if (right.kind === "composite" && right.operator === "and") return children(right).every((part) => steeringExpressionImplies(left, part));
  if (left.kind === "composite" && left.operator === "or") return children(left).every((part) => steeringExpressionImplies(part, right));
  if (left.kind === "composite" && left.operator === "and" && children(left).some((part) => steeringExpressionImplies(part, right))) return true;
  if (right.kind === "composite" && right.operator === "or") return children(right).some((part) => steeringExpressionImplies(left, part));
  if (left.kind === "path" && right.kind === "path") return left.selectors.every((a) => right.selectors.some((b) => pathImplies(a, b)));
  if (left.kind === "phase" && right.kind === "phase") return left.phases.every((phase) => right.phases.includes(phase));
  if ((left.kind === "spec-kind" && right.kind === "spec-kind") || (left.kind === "task-kind" && right.kind === "task-kind"))
    return left.kinds.every((kind) => right.kinds.some((other) => exact(kind, other)));
  return false;
}
export function steeringScopesDisjoint(left: SteeringScope, right: SteeringScope): boolean {
  if (left.kind === "composite") return left.operator === "or" ?
    left.scopes.every((part) => steeringScopesDisjoint(part, right)) : left.scopes.some((part) => steeringScopesDisjoint(part, right));
  if (right.kind === "composite") return right.operator === "or" ?
    right.scopes.every((part) => steeringScopesDisjoint(left, part)) : right.scopes.some((part) => steeringScopesDisjoint(left, part));
  if (left.kind === "path" && right.kind === "path") return left.selectors.every((a) => right.selectors.every((b) => pathDisjoint(a, b)));
  if (left.kind === "phase" && right.kind === "phase") return !left.phases.some((phase) => right.phases.includes(phase));
  if ((left.kind === "spec-kind" && right.kind === "spec-kind") || (left.kind === "task-kind" && right.kind === "task-kind"))
    return !left.kinds.some((kind) => right.kinds.some((other) => exact(kind, other)));
  return false;
}
export function steeringScopeEmpty(scope: SteeringScope): boolean {
  if (scope.kind !== "composite") return false;
  if (scope.operator === "or") return scope.scopes.every(steeringScopeEmpty);
  return scope.scopes.some(steeringScopeEmpty) || scope.scopes.some((a, i) => scope.scopes.slice(i + 1).some((b) => steeringScopesDisjoint(a, b)));
}
export function compareSteeringScopes(left: SteeringScope, right: SteeringScope): SteeringScopeRelation {
  left = orderSteeringExpression(left); right = orderSteeringExpression(right);
  if (!steeringScopeSchema.safeParse(left).success || !steeringScopeSchema.safeParse(right).success || steeringScopeEmpty(left) || steeringScopeEmpty(right)) return "invalid";
  const forward = steeringExpressionImplies(left, right), reverse = steeringExpressionImplies(right, left);
  if (forward && reverse) return "equal";
  if (forward) return "narrower";
  if (reverse) return "wider";
  return steeringScopesDisjoint(left, right) ? "disjoint" : "overlapping-incomparable";
}
/** Internal intersection for residual-region proofs, not an authored scope decoder. */
export function intersectSteeringScopes(left: SteeringScope, right: SteeringScope): SteeringScope {
  if (steeringExpressionImplies(left, right)) return left;
  if (steeringExpressionImplies(right, left)) return right;
  const parts = [left, right].flatMap((scope) => scope.kind === "composite" && scope.operator === "and" ? scope.scopes : [scope]);
  return { kind: "composite", operator: "and", scopes: distinct(parts) };
}

/** Evaluate every child, even under OR=true or AND=false. Unknown path observation is never empty. */
export function evaluateSteeringExpression(expression: Expression, action: SteeringAction, manualSelected = false): SteeringEvaluation {
  expression = orderSteeringExpression(expression);
  const evaluated = children(expression).map((part) => evaluateSteeringExpression(part, action, manualSelected));
  const missing: string[] = evaluated.flatMap((part) => part.missing);
  let matchedPaths: string[] = evaluated.flatMap((part) => part.matched_paths), match = false;
  switch (expression.kind) {
    case "always": case "project-global": match = true; break;
    case "manual": match = manualSelected; break;
    case "phase":
      if (action.phase === undefined) missing.push("phase");
      else match = expression.phases.includes(action.phase);
      break;
    case "path":
      if (action.paths === undefined || action.paths.status === "unknown") missing.push("paths");
      else {
        matchedPaths = action.paths.paths.filter((path) => expression.selectors.some((selector) => matchesPath(selector, path)));
        match = matchedPaths.length > 0;
      }
      break;
    case "spec-kind": match = action.spec !== undefined && expression.kinds.some((kind) => exact(kind, action.spec!.selector)); break;
    case "task-kind": match = action.task !== undefined && expression.kinds.some((kind) => exact(kind, action.task!.selector)); break;
    case "composite": match = expression.operator === "and" ? evaluated.every((part) => part.outcome === "match") : evaluated.some((part) => part.outcome === "match"); break;
  }
  return { declaration: expression, outcome: missing.length ? "error" : match ? "match" : "miss", children: evaluated,
    matched_paths: distinct(matchedPaths), missing: distinct(missing) };
}
/** Semantic coverage for this evaluated action. Manual/always are gates, not extra scope authority. */
export function steeringEvaluationScope(evaluation: SteeringEvaluation): SteeringScope | undefined {
  if (evaluation.outcome !== "match") return undefined;
  const expression = evaluation.declaration;
  if (expression.kind === "always" || expression.kind === "manual" || expression.kind === "project-global") return { kind: "project-global" };
  if (expression.kind !== "composite") return expression;
  const scopes = evaluation.children.map(steeringEvaluationScope).filter((scope): scope is SteeringScope => scope !== undefined);
  if (expression.operator === "or") return unionSteeringScopes(scopes);
  return scopes.reduce(intersectSteeringScopes, { kind: "project-global" });
}
export function unionSteeringScopes(scopes: readonly SteeringScope[]): SteeringScope {
  if (scopes.some((scope) => scope.kind === "project-global")) return { kind: "project-global" };
  const parts = distinct(scopes.flatMap((scope) => scope.kind === "composite" && scope.operator === "or" ? scope.scopes : [scope]));
  if (parts.length === 1) return parts[0]!;
  return { kind: "composite", operator: "or", scopes: parts };
}
export const containsManualSelector = (expression: SteeringInclusionSelector): boolean => expression.kind === "manual" ||
  (expression.kind === "composite" && expression.selectors.some(containsManualSelector));
