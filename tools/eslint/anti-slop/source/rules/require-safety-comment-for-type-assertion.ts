import { defineRule } from "../eslint-compat.ts";
import {
	containsUnparsedTop,
	typeAtNode,
	typeCheckerFor,
} from "../shared/type-information.ts";
import { isGeneratedSdkSource, isTestFilename } from "../shared/file-scope.ts";

import type { ESTree, SourceCode } from "../eslint-compat.ts";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;
type RuntimeFunction =
	| ESTree.ArrowFunctionExpression
	| ESTree.FunctionDeclaration
	| ESTree.FunctionExpression;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function isTypeAssertion(node: ESTree.Node | null): node is TypeAssertion {
	return node?.type === "TSAsExpression" || node?.type === "TSTypeAssertion";
}

function isBoundaryFunction(node: RuntimeFunction | null): boolean {
	if (node === null) return false;
	if (node.returnType?.typeAnnotation.type === "TSTypePredicate") return true;
	const name =
		node.id?.name ??
		(node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
			? node.parent.id.name
			: null);
	return name !== null && /^(?:is|has|assert|parse|read|validate|normalize|decode|deserialize|coerce|sanitize|scrub|strip|unwrap|extract|yup)(?:[A-Z0-9_]|$)/u.test(name);
}

function isPublicCallable(node: RuntimeFunction): boolean {
	if (node.type === "FunctionDeclaration") {
		return node.parent.type === "ExportNamedDeclaration" || node.parent.type === "ExportDefaultDeclaration";
	}
	if (node.parent.type === "MethodDefinition") return true;
	if (node.parent.type !== "VariableDeclarator") return false;
	const declaration = node.parent.parent;
	return declaration.type === "VariableDeclaration" && declaration.parent.type === "ExportNamedDeclaration";
}

function enclosingFunction(node: ESTree.Node): RuntimeFunction | null {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) return current;
		current = current.parent ?? null;
	}
	return null;
}

function enclosingFunctionDepth(node: ESTree.Node): number {
	let depth = 0;
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) depth++;
		current = current.parent ?? null;
	}
	return depth;
}

function isPrimitiveAssertion(node: TypeAssertion): boolean {
	const type = node.typeAnnotation;
	return (
		type.type === "TSStringKeyword" ||
		type.type === "TSNumberKeyword" ||
		type.type === "TSBooleanKeyword" ||
		type.type === "TSBigIntKeyword" ||
		type.type === "TSSymbolKeyword" ||
		type.type === "TSNullKeyword" ||
		type.type === "TSUndefinedKeyword"
	);
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
	const owner = enclosingFunction(node);
	if (owner !== null) {
		const ownerComments: ESTree.Node[] = [owner];
		if (owner.parent.type === "VariableDeclarator") {
			ownerComments.push(owner.parent);
			if (owner.parent.parent.type === "VariableDeclaration") ownerComments.push(owner.parent.parent);
		}
		if (ownerComments.some((candidate) =>
			sourceCode.getCommentsBefore(candidate).some((comment) => /\bSAFETY\s*:/u.test(comment.value))
		)) return true;
	}
  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some((comment) => comment.range[1] <= node.range[0] && /\bSAFETY\s*:/u.test(comment.value))
    ) {
      return true;
    }
    if (commentOwnerKinds.has(current.type) || current.parent.type === "Program") return false;
    current = current.parent ?? null;
  }
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
	createOnce(context) {
		if (isTestFilename(context.getFilename()) || isGeneratedSdkSource(context.sourceCode.text)) return {};
		const checker = typeCheckerFor(context);
	const checkAssertion = (node: TypeAssertion) => {
			// The outer assertion is the useful boundary; reporting both halves of
			// `value as unknown as Domain` creates duplicate work for one escape hatch.
			if (isTypeAssertion(node.parent) && node.parent.expression === node) return;
			// A callback's assertions are implementation details of its owning
			// boundary. Requiring a duplicate comment on every callback cast adds
			// noise without documenting a new invariant.
			if (enclosingFunctionDepth(node) > 1) return;
			const owner = enclosingFunction(node);
			if (owner !== null && !isPublicCallable(owner)) return;
			if (
				isConstAssertion(node) ||
				isPrimitiveAssertion(node) ||
				isBoundaryFunction(owner) ||
				hasSafetyComment(context.sourceCode, node)
			) return;
			const sourceType = typeAtNode(checker, context, node.expression);
			if (sourceType !== null && !containsUnparsedTop(sourceType)) return;
			context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
