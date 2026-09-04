import type { ParserServicesWithTypeInformation } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";
import ts from "typescript";

type RuleContext = TSESLint.RuleContext<string, readonly unknown[]>;

/** Return TypeScript's checker when ESLint was configured with a project. */
export function typeCheckerFor(
  context: RuleContext,
): ts.TypeChecker | null {
  const services = context.sourceCode.parserServices;
  if (
    services === undefined ||
    !isTypedParserServices(services)
  ) {
    return null;
  }
  return services.program.getTypeChecker();
}

function isTypedParserServices(
  services: NonNullable<RuleContext["sourceCode"]["parserServices"]>,
): services is ParserServicesWithTypeInformation {
	return (
		services.program != null &&
		services.esTreeNodeToTSNodeMap !== undefined
	);
}

/** Resolve a TypeScript type for an ESLint node when type information exists. */
export function typeAtNode(
  checker: ts.TypeChecker | null,
  context: RuleContext,
  node: TSESTree.Node,
): ts.Type | null {
  const services = context.sourceCode.parserServices;
  if (
    checker === null ||
    services === undefined ||
    !isTypedParserServices(services)
  ) {
    return null;
  }
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  return checker.getTypeAtLocation(tsNode);
}

/** Whether a type still contains an unparsed top value. */
export function containsUnparsedTop(type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return true;
  }
  if (type.isUnion()) return type.types.some(containsUnparsedTop);
  return false;
}
