import { defineRule } from "../eslint-compat.ts";

import {
	classifyUnsafeDictionary,
	classifyUnsafeDictionaryValue,
	createTypeEnvironment,
	type TypeEnvironment,
} from "../shared/dictionary-types.ts";
import { isGeneratedSdkSource, isTestFilename } from "../shared/file-scope.ts";

import type { ESTree } from "../eslint-compat.ts";

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.TSDeclareFunction | ESTree.TSEmptyBodyFunctionExpression;

const typeNodeKinds: ReadonlySet<string> = new Set([
	"JSDocNonNullableType",
	"JSDocNullableType",
	"JSDocUnknownType",
	"TSAnyKeyword",
	"TSArrayType",
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSConditionalType",
	"TSConstructorType",
	"TSFunctionType",
	"TSImportType",
	"TSIndexedAccessType",
	"TSInferType",
	"TSIntersectionType",
	"TSIntrinsicKeyword",
	"TSLiteralType",
	"TSMappedType",
	"TSNamedTupleMember",
	"TSNeverKeyword",
	"TSNullKeyword",
	"TSNumberKeyword",
	"TSObjectKeyword",
	"TSParenthesizedType",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSTemplateLiteralType",
	"TSThisType",
	"TSTupleType",
	"TSTypeLiteral",
	"TSTypeOperator",
	"TSTypePredicate",
	"TSTypeQuery",
	"TSTypeReference",
	"TSUndefinedKeyword",
	"TSUnionType",
	"TSUnknownKeyword",
	"TSVoidKeyword",
]);

function isTypeNode(node: ESTree.Node): node is ESTree.TypeNode {
	return typeNodeKinds.has(node.type);
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isInsideTypeAliasDeclaration(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (current.type === "TSTypeAliasDeclaration") return true;
		current = current.parent ?? null;
	}
	return false;
}

function isInsideTypePredicate(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (current.type === "TSTypePredicate") return true;
		current = current.parent ?? null;
	}
	return false;
}

function isInsideValidationFunction(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression"
		) {
			if (current.returnType?.typeAnnotation.type === "TSTypePredicate") return true;
			const name = current.id?.name ??
				(current.parent.type === "VariableDeclarator" && current.parent.id.type === "Identifier"
					? current.parent.id.name
					: null);
			return name !== null && /^(?:is|has|assert|parse|read|validate|normalize|decode|deserialize|coerce|sanitize|scrub|strip|unwrap|extract|yup)(?:[A-Z0-9_]|$)/u.test(name);
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

function isFunctionSignatureType(node: ESTree.Node, functionNode: FunctionNode): boolean {
	return functionNode.params.some((parameter) => isDescendantOf(node, parameter)) ||
		(functionNode.returnType !== undefined && isDescendantOf(node, functionNode.returnType));
}

function isPublicTypeContext(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if (
			current.type === "TSTypeAliasDeclaration" ||
			current.type === "TSInterfaceDeclaration"
		) {
			return current.parent.type === "ExportNamedDeclaration" || current.parent.type === "ExportDefaultDeclaration";
		}
		if (
			current.type === "FunctionDeclaration" ||
			current.type === "TSDeclareFunction" ||
			current.type === "MethodDefinition"
		) {
			if (current.type === "MethodDefinition") {
				return isFunctionSignatureType(node, current.value);
			}
			if (current.type === "TSDeclareFunction") return true;
			if (!isFunctionSignatureType(node, current)) return false;
			return current.parent.type === "ExportNamedDeclaration" || current.parent.type === "ExportDefaultDeclaration";
		}
		if (
			current.type === "ArrowFunctionExpression" ||
			current.type === "FunctionExpression"
		) {
			if (!isFunctionSignatureType(node, current)) return false;
			const parent = current.parent;
			if (parent.type !== "VariableDeclarator") return false;
			const declaration = parent.parent;
	return declaration.type === "VariableDeclaration" && declaration.parent.type === "ExportNamedDeclaration";
		}
		if (current.type === "TSAsExpression" || current.type === "TSTypeAssertion") return false;
		if (current.type === "VariableDeclarator") {
			const declaration = current.parent;
			return declaration.type === "VariableDeclaration" && declaration.parent.type === "ExportNamedDeclaration";
		}
		current = current.parent ?? null;
	}
	return false;
}

function isPlainAliasConsumerUse(node: ESTree.TypeNode, environment: TypeEnvironment): boolean {
	if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
	const name = typeReferenceName(node);
	return name !== null && environment.aliases.has(name) && !isInsideTypeAliasDeclaration(node);
}

function shouldReportType(node: ESTree.TypeNode, environment: TypeEnvironment): boolean {
	if (!isPublicTypeContext(node)) return false;
	if (isInsideTypePredicate(node) || isInsideValidationFunction(node)) return false;
	if (isPlainAliasConsumerUse(node, environment)) return false;
	if (classifyUnsafeDictionary(node, environment) === null) return false;
	let current: ESTree.Node | null = node.parent ?? null;
	while (current !== null && current.type !== "Program") {
		if (isTypeNode(current) && classifyUnsafeDictionary(current, environment) !== null)
			return false;
		current = current.parent ?? null;
	}
	return true;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryTypeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
		},
		messages: {
			unsafeDictionary:
				"This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
		},
	},
	createOnce(context) {
		if (isTestFilename(context.getFilename()) || isGeneratedSdkSource(context.sourceCode.text)) return {};
		let environment: TypeEnvironment | null = null;
		const report = (node: ESTree.Node, value: string) => {
			context.report({ node, messageId: "unsafeDictionary", data: { value } });
		};
		const reportIfUnsafe = (node: ESTree.TypeNode) => {
			if (environment === null || !shouldReportType(node, environment)) return;
			const unsafe = classifyUnsafeDictionary(node, environment);
			if (unsafe === null) return;
			report(node, unsafe.unsafeValue);
		};

		return {
			Program(node) {
				environment = createTypeEnvironment(node);
			},
			TSTypeReference: reportIfUnsafe,
			TSTypeLiteral: reportIfUnsafe,
			TSMappedType: reportIfUnsafe,
			TSIndexSignature(node) {
				if (
					environment === null ||
					node.typeAnnotation == null ||
					node.parent.type === "TSTypeLiteral" ||
					!isPublicTypeContext(node)
				)
					return;
				const unsafe = classifyUnsafeDictionaryValue(
					node.typeAnnotation.typeAnnotation,
					environment,
				);
				if (unsafe !== null) report(node, unsafe.unsafeValue);
			},
		};
	},
});
