import { defineRule } from "../eslint-compat.ts";
import type { ESTree } from "../eslint-compat.ts";
import { isGeneratedSdkSource, isTestFilename } from "../shared/file-scope.ts";
import { containsUnparsedTop, typeAtNode, typeCheckerFor } from "../shared/type-information.ts";

type TypeAssertionExpression = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function isTypeAssertionExpression(node: ESTree.Node): node is TypeAssertionExpression {
  return node.type === "TSAsExpression" || node.type === "TSTypeAssertion";
}

function isConstAssertion(node: TypeAssertionExpression): boolean {
  const { typeAnnotation } = node;
  return (
    typeAnnotation.type === "TSTypeReference" &&
    typeAnnotation.typeName.type === "Identifier" &&
    typeAnnotation.typeName.name === "const"
  );
}

function isOutermostAssertionInChain(node: TypeAssertionExpression): boolean {
  const parent = node.parent;
  return !isTypeAssertionExpression(parent) || parent.expression !== node;
}

function chainBase(node: TypeAssertionExpression): ESTree.Expression {
	let current: ESTree.Expression = node;
	while (isTypeAssertionExpression(current)) current = current.expression;
	return current;
}

function isForbiddenAssertionChain(node: TypeAssertionExpression, checker: ReturnType<typeof typeCheckerFor>, context: Parameters<typeof typeAtNode>[1]): boolean {
  let assertionCount = 0;
  let hasNonConstAssertion = false;
  let current: ESTree.Expression = node;

  while (isTypeAssertionExpression(current)) {
    assertionCount += 1;
    hasNonConstAssertion ||= !isConstAssertion(current);
    current = current.expression;
  }

	if (assertionCount <= 1 || !hasNonConstAssertion) return false;
	const baseType = typeAtNode(checker, context, chainBase(node));
	// A chain over a value that already has a concrete static type is a local
	// refinement, not an unparsed boundary escape. Keep the check focused on
	// assertions that actually discard evidence.
	return baseType === null || containsUnparsedTop(baseType);
}

/** Disallow nested TypeScript type assertions, while permitting chains made only of const assertions. */
export const noChainedTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow chained TypeScript as and angle-bracket assertions, including parenthesized chains.",
    },
    messages: {
      chained:
        "This assertion chain discards type evidence. Keep the original precise type, or parse untrusted input at its boundary before narrowing it.",
    },
	},
	createOnce(context) {
		if (isTestFilename(context.getFilename()) || isGeneratedSdkSource(context.sourceCode.text)) return {};
		const checker = typeCheckerFor(context);
		const checkTypeAssertion = (node: TypeAssertionExpression) => {
			if (!isOutermostAssertionInChain(node) || !isForbiddenAssertionChain(node, checker, context)) return;
      context.report({ node, messageId: "chained" });
    };

    return {
      TSAsExpression: checkTypeAssertion,
      TSTypeAssertion: checkTypeAssertion,
    };
  },
});
