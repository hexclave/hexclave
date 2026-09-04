import { defineRule } from "../eslint-compat.ts";
import type { ESTree } from "../eslint-compat.ts";

function containsForbiddenSymbolName(name: string): boolean {
  // Domain contracts commonly use names such as `DeploymentApiShape`; the
  // anti-slop signal is the unqualified placeholder name, not that vocabulary.
  return /^(?:shape|shapes)$/iu.test(name);
}

/** Ban unqualified placeholder symbols named "shape" while preserving domain contract names. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow unqualified "shape" placeholder names in JavaScript, TypeScript, private, and JSX symbols.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      const parent = node.parent;
      if (parent === undefined) return;
      if (
        (parent.type === "MemberExpression" && !parent.computed && parent.property === node) ||
        (parent.type === "Property" && parent.key === node && parent.value !== node) ||
        (parent.type === "MethodDefinition" && parent.key === node) ||
        (parent.type === "JSXAttribute" && parent.name === node)
      ) {
        return;
      }
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
    };
  },
});
