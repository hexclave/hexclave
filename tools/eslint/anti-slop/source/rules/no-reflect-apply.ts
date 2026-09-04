import { defineRule } from "../eslint-compat.ts";
import type { ESTree } from "../eslint-compat.ts";

import { isGlobalReflectMethodCall } from "../shared/reflect-method.ts";

function isProxyApplyTrap(node: ESTree.CallExpression): boolean {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "Property" &&
			current.key.type === "Identifier" &&
			current.key.name === "apply" &&
			current.parent.type === "ObjectExpression" &&
			current.parent.parent.type === "NewExpression" &&
			current.parent.parent.callee.type === "Identifier" &&
			current.parent.parent.callee.name === "Proxy"
		) {
			return true;
		}
		current = current.parent ?? null;
	}
	return false;
}

/** Ban Reflect.apply, which bypasses ordinary typed function calls. */
export const noReflectApplyRule = defineRule({
  meta: {
    type: "problem",
    fixable: "code",
    docs: {
      description:
        "Disallow Reflect.apply; call typed functions directly or model dynamic dispatch behind an interface.",
    },
    messages: {
      reflectApply:
        "Replace `Reflect.apply` with a typed function call. Model dynamic dispatch behind a named interface.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super") return;
        if (isGlobalReflectMethodCall(context.sourceCode, node.callee, "apply")) {
          if (isProxyApplyTrap(node)) return;
          context.report({
            node,
            messageId: "reflectApply",
            fix(fixer) {
              if (node.arguments.length !== 3) return null;
              const [callee, thisArg, argumentsList] = node.arguments;
              if (
                callee === undefined ||
                thisArg === undefined ||
                argumentsList === undefined ||
                argumentsList.type !== "ArrayExpression"
              ) {
                return null;
              }
              const calleeText = context.sourceCode.getText(callee);
              const thisArgText = context.sourceCode.getText(thisArg);
              const argsText = argumentsList.elements
                .map((element) => (element === null ? "undefined" : context.sourceCode.getText(element)))
                .join(", ");
              if (thisArg.type === "Literal" && thisArg.value === null) {
                return fixer.replaceText(node, `${calleeText}(${argsText})`);
              }
              return fixer.replaceText(node, `${calleeText}.call(${thisArgText}${argsText === "" ? "" : `, ${argsText}`})`);
            },
          });
        }
      },
    };
  },
});
