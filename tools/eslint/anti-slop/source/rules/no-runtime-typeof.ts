import { defineRule } from "../eslint-compat.ts";
import {
	containsUnparsedTop,
	typeAtNode,
	typeCheckerFor,
} from "../shared/type-information.ts";
import { isGeneratedSdkSource, isTestFilename } from "../shared/file-scope.ts";

import type { ESTree } from "../eslint-compat.ts";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.TSDeclareFunction | ESTree.TSEmptyBodyFunctionExpression;

function parameterHasUnknownType(parameter: ESTree.Parameter): boolean {
	if (parameter.type === "TSParameterProperty") return parameterHasUnknownType(parameter.parameter);
	return parameter.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword";
}

function acceptsUnknownInput(node: RuntimeFunction): boolean {
	return node.params.some(parameterHasUnknownType);
}

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent ?? null;
	}
	return false;
}

function isValidationFunction(node: ESTree.Node): boolean {
	let current: RuntimeFunction | null = null;
	let ancestor: ESTree.Node | null = node.parent ?? null;
	while (ancestor !== null && ancestor.type !== "Program") {
		if (isRuntimeFunction(ancestor)) {
			current = ancestor;
			break;
		}
		ancestor = ancestor.parent ?? null;
	}
	if (current === null) return false;
	if (current.returnType?.typeAnnotation.type === "TSTypePredicate") return true;
	if (acceptsUnknownInput(current)) return true;
	const name =
		current.id?.name ??
		(current.parent.type === "VariableDeclarator" && current.parent.id.type === "Identifier"
			? current.parent.id.name
			: null);
	return name !== null && /^(?:is|has|assert|parse|read|validate|normalize|decode|deserialize|coerce|sanitize|scrub|strip|unwrap|extract|yup)(?:[A-Z0-9_]|$)/u.test(name);
}

/** A type check that is part of an actual branch is doing boundary work. A
 * standalone `typeof` expression, by contrast, narrows nothing for callers
 * and is the slop this rule is meant to catch. */
function isGuardCondition(node: ESTree.UnaryExpression): boolean {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (
			(current.type === "IfStatement" && isDescendantOf(node, current.test)) ||
			(current.type === "ConditionalExpression" && isDescendantOf(node, current.test))
		) return true;
		if (current.type === "ArrowFunctionExpression" && isDescendantOf(node, current.body)) {
			const call = current.parent;
			if (
				call.type === "CallExpression" &&
				call.callee.type === "MemberExpression" &&
				!call.callee.computed &&
				call.callee.property.type === "Identifier" &&
				(call.callee.property.name === "every" ||
					call.callee.property.name === "some" ||
					call.callee.property.name === "filter" ||
					call.callee.property.name === "test" ||
					call.callee.property.name === "transform")
			) return true;
		}
		if (
			current.type === "CallExpression" &&
			current.callee.type === "Identifier" &&
			current.callee.name === "expect"
		) return true;
		if (current.type === "ThrowStatement" || current.type === "NewExpression") return true;
		if (current.type === "VariableDeclarator" && current.init !== null && isBooleanExpression(current.init)) return true;
		if (current.type === "ReturnStatement") {
			let owner: ESTree.Node | null = current.parent ?? null;
			while (owner !== null && owner.type !== "Program") {
				if (
					(owner.type === "ArrowFunctionExpression" ||
						owner.type === "FunctionDeclaration" ||
						owner.type === "FunctionExpression") &&
					owner.returnType?.typeAnnotation.type === "TSBooleanKeyword"
				) return true;
				owner = owner.parent ?? null;
			}
		}
		current = current.parent ?? null;
	}
	return false;
}

function isDescendantOf(node: ESTree.Node, ancestor: ESTree.Node): boolean {
	let current: ESTree.Node | null = node;
	while (current !== null) {
		if (current === ancestor) return true;
		current = current.parent ?? null;
	}
	return false;
}

function isBooleanExpression(node: ESTree.Node): boolean {
	if (node.type === "BinaryExpression") {
		return ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"].includes(node.operator);
	}
	if (node.type === "LogicalExpression") return isBooleanExpression(node.left) && isBooleanExpression(node.right);
	if (node.type === "UnaryExpression") return node.operator === "!";
	return false;
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
			properties: {
				allowInTypeGuards: { type: "boolean" },
				allowInValidationFunctions: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		if (isTestFilename(context.getFilename()) || isGeneratedSdkSource(context.sourceCode.text)) return {};
		const checker = typeCheckerFor(context);
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					"allowInTypeGuards" in option &&
					option.allowInTypeGuards === true;
				const allowInValidationFunctions =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					"allowInValidationFunctions" in option &&
					option.allowInValidationFunctions === true;
				if (node.operator !== "typeof") return;
				if (
					(allowInTypeGuards && isInsideTypeGuard(node)) ||
					(allowInValidationFunctions && (isValidationFunction(node) || isGuardCondition(node)))
				) return;
				const operandType = typeAtNode(checker, context, node.argument);
				if (operandType !== null && !containsUnparsedTop(operandType)) return;
				if (node.operator === "typeof") {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
