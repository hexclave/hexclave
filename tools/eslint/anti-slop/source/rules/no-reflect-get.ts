import { defineRule } from "../eslint-compat.ts";

import { isGlobalReflectMethodCall } from "../shared/reflect-method.ts";

/** Ban Reflect.get, which bypasses ordinary property access and useful type evidence. */
export const noReflectGetRule = defineRule({
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Disallow Reflect.get; use typed property access or parse dynamic input into a domain type.",
    },
    messages: {
      reflectGet:
        "Replace `Reflect.get` with typed property access. Parse dynamic input into a named domain type before reading it.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super") return;
        if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "get")) {
          // A receiver argument is part of Proxy's get trap contract and cannot be
          // represented by ordinary bracket access without changing semantics.
          if (node.arguments.length === 3) return;
          context.report({
            node,
            messageId: "reflectGet",
            fix(fixer) {
              if (node.arguments.length !== 2) return null;
              const [target, property] = node.arguments;
              if (target === undefined || property === undefined) return null;
              return fixer.replaceText(
                node,
                `${context.sourceCode.getText(target)}[${context.sourceCode.getText(property)}]`,
              );
            },
          });
        }
      },
    };
  },
});
