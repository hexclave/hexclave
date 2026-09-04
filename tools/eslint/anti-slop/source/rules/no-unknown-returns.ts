import { defineRule } from "../eslint-compat.ts";

import type { ESTree } from "../eslint-compat.ts";

import { lexicalTypeParameterNames } from "../shared/lexical-type-parameters.ts";
import { isGeneratedSdkSource, isTestFilename } from "../shared/file-scope.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.FunctionDeclaration
  | ESTree.FunctionExpression
  | ESTree.TSDeclareFunction
  | ESTree.TSEmptyBodyFunctionExpression
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.FunctionDeclaration | ESTree.FunctionExpression;

function isRuntimeFunction(node: FunctionWithReturnType): node is RuntimeFunction {
  return node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration" || node.type === "FunctionExpression";
}

function functionName(node: RuntimeFunction, sourceText: string): string | null {
  if (node.id !== null) return node.id.name;
  return node.parent.type === "VariableDeclarator" && node.parent.id.type === "Identifier"
    ? node.parent.id.name
    : sourceText.match(/^(?:async\s+)?function\*?\s*([A-Za-z_$][\w$]*)/u)?.[1] ?? null;
}

function isBoundaryFunction(node: FunctionWithReturnType, sourceText: string): boolean {
  if (!isRuntimeFunction(node)) return false;
  const name = functionName(node, sourceText);
  return name !== null && /^(?:is|has|assert|parse|read|validate|normalize|decode|deserialize|coerce|sanitize|scrub|strip|unwrap|extract|yup)(?:[A-Z0-9_]|$)/u.test(name);
}

/** Keep the rule focused on callable contracts; nested implementation helpers
 * inherit the domain type from the public function that owns them. */
function isPublicCallable(node: FunctionWithReturnType): boolean {
  if (
    node.type === "TSCallSignatureDeclaration" ||
    node.type === "TSConstructSignatureDeclaration" ||
    node.type === "TSConstructorType" ||
    node.type === "TSDeclareFunction" ||
    node.type === "TSEmptyBodyFunctionExpression" ||
    node.type === "TSFunctionType" ||
    node.type === "TSMethodSignature"
  ) return true;

  if (node.type === "FunctionDeclaration") {
    return node.parent.type === "Program" || node.parent.type === "ExportNamedDeclaration" || node.parent.type === "ExportDefaultDeclaration";
  }

  if (node.parent.type !== "VariableDeclarator") return false;
  const declaration = node.parent.parent;
  if (declaration.type !== "VariableDeclaration") return false;
  return declaration.parent.type === "Program" || declaration.parent.type === "ExportNamedDeclaration";
}

function referencedAliasName(type: ESTree.TypeNode): string | null {

  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    if (isTestFilename(context.getFilename()) || isGeneratedSdkSource(context.sourceCode.text)) return {};
    const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();

    const resolvesToUnknown = (
      type: ESTree.TypeNode,
      shadowedAliases: ReadonlySet<string>,
      visited = new Set<string>(),
    ): boolean => {
      if (type.type === "TSUnknownKeyword") return true;

      if (type.type === "TSUnionType") {
        return type.types.some((member) =>
          resolvesToUnknown(member, shadowedAliases, visited),
        );
      }
      if (
        type.type === "TSTypeReference" &&
        type.typeName.type === "Identifier" &&
        (type.typeName.name === "Promise" || type.typeName.name === "PromiseLike")
      ) {
        const value = type.typeArguments?.params[0];
        return value !== undefined && resolvesToUnknown(value, shadowedAliases, visited);
      }
      const name = referencedAliasName(type);
      if (name === null || visited.has(name) || shadowedAliases.has(name)) return false;
      const alias = aliases.get(name);
      if (
        alias === undefined ||
        (alias.typeParameters !== null && alias.typeParameters !== undefined)
      ) {
        return false;
      }
      const nextVisited = new Set(visited);
      nextVisited.add(name);
      return resolvesToUnknown(alias.typeAnnotation, shadowedAliases, nextVisited);
    };

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!isPublicCallable(node)) return;
      if (isBoundaryFunction(node, context.sourceCode.getText(node))) return;
      if (
        !resolvesToUnknown(
          annotation.typeAnnotation,
          lexicalTypeParameterNames(node, context.sourceCode.visitorKeys),
        )
      ) {
        return;
      }
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      Program(node) {
        aliases.clear();
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type === "TSTypeAliasDeclaration") {
            aliases.set(declaration.id.name, declaration);
          }
        }
      },
      ArrowFunctionExpression: checkReturnType,
      FunctionDeclaration: checkReturnType,
      FunctionExpression: checkReturnType,
      TSCallSignatureDeclaration: checkReturnType,
      TSConstructSignatureDeclaration: checkReturnType,
      TSConstructorType: checkReturnType,
      TSDeclareFunction: checkReturnType,
      TSEmptyBodyFunctionExpression: checkReturnType,
      TSFunctionType: checkReturnType,
      TSMethodSignature: checkReturnType,
    };
  },
});
