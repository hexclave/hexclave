import { defineRule } from "../eslint-compat.ts";
import type { ESTree } from "../eslint-compat.ts";

function isEmptyObjectExpression(node: ESTree.Expression): boolean {
  return node.type === "ObjectExpression" && node.properties.length === 0;
}

function isConditionalEmptyObjectSpread(
	node: ESTree.Expression,
): node is ESTree.ConditionalExpression {
  const conditional = node;
  return (
    conditional.type === "ConditionalExpression" &&
    (isEmptyObjectExpression(conditional.consequent) ||
      isEmptyObjectExpression(conditional.alternate))
  );
}

function isExplicitPropertyObject(node: ESTree.Expression): boolean {
	return (
		node.type === "ObjectExpression" &&
		node.properties.length > 0 &&
		node.properties.every((property) => property.type === "Property")
	);
}

/** Ban conditional empty-object spreads without changing their omission semantics. */
export const noConditionalEmptyObjectSpreadRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow object spreads that conditionally spread an empty object to omit fields.",
    },
    messages: {
      avoid:
        "This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present.",
    },
  },
  createOnce(context) {
    return {
      SpreadElement(node) {
        if (node.parent.type !== "ObjectExpression") return;

        if (!isConditionalEmptyObjectSpread(node.argument)) return;
        const conditional = node.argument;
        const nonEmptyBranch =
          conditional.consequent.type === "ObjectExpression" &&
          conditional.consequent.properties.length > 0
            ? conditional.consequent
            : conditional.alternate;
        // A literal with explicit properties communicates the omission directly;
        // reserve this rule for opaque or nested object construction.
        if (isExplicitPropertyObject(nonEmptyBranch)) return;
		context.report({ node, messageId: "avoid" });
      },
    };
  },
});
