import type { TSESTree } from "@typescript-eslint/utils";
import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(() => "docs/lint-policy.md");
const isConstantObject = (node: TSESTree.Node | null): boolean =>
  node?.type === "ObjectExpression" ||
  ((node?.type === "TSAsExpression" || node?.type === "TSSatisfiesExpression") && isConstantObject(node.expression));
const literalMessageFields = new Set(["code", "error", "message", "prompt", "system", "instructions", "text"]);
const readStaticText = (node: TSESTree.Node | null | undefined): string | null => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }

  return null;
};

export const boundaryRules = {
  "comment-and-log": createRule({
    name: "comment-and-log",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "suggestion",
      schema: [],
      messages: {
        todo: "Write TODO(cleanup): followed by the specific temporary constraint.",
        period: "End literal or template log messages with a period.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        Program() {
          context.sourceCode.getAllComments().forEach((comment) => {
            if (/\bTODO\b/.test(comment.value) && /\bTODO\b(?!\(cleanup\):\s+\S)/.test(comment.value)) {
              context.report({ loc: comment.loc, messageId: "todo" });
            }
          });
        },
        CallExpression(node) {
          const callee = node.callee;
          if (
            callee.type !== "MemberExpression" ||
            callee.object.type !== "Identifier" ||
            !["console", "logger", "log"].includes(callee.object.name) ||
            callee.property.type !== "Identifier" ||
            !["log", "info", "warn", "error", "debug", "trace", "fatal"].includes(callee.property.name)
          ) {
            return;
          }
          const argument = node.arguments.at(0);
          if (!argument) {
            return;
          }
          const ending =
            argument.type === "TemplateLiteral" ? argument.quasis.at(-1)?.value.cooked : readStaticText(argument);
          if (ending !== null && ending !== undefined && !ending.trimEnd().endsWith(".")) {
            context.report({ node: argument, messageId: "period" });
          }
        },
      };
    },
  }),
  "named-messages": createRule({
    name: "named-messages",
    meta: {
      docs: { description: "Enforce the documented authored-code convention." },
      type: "suggestion",
      schema: [],
      messages: {
        constant:
          "Move API codes, error messages, prompts, and user-facing message text into named domain constants or copy modules.",
      },
    },
    defaultOptions: [],
    create(context) {
      const check = (node: TSESTree.Node | null | undefined) => {
        if (node && (readStaticText(node) !== null || node.type === "TemplateLiteral")) {
          context.report({ node, messageId: "constant" });
        }
      };

      return {
        Property(node) {
          const name = node.key.type === "Identifier" && !node.computed ? node.key.name : readStaticText(node.key);
          // Constant declarations are the intended home for grouped copy and protocol strings.
          const ancestors = context.sourceCode.getAncestors(node);
          if (
            !ancestors.some((ancestor) =>
              ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(ancestor.type),
            ) &&
            ancestors.some(
              (ancestor) =>
                ancestor.type === "VariableDeclarator" &&
                ancestor.parent.kind === "const" &&
                isConstantObject(ancestor.init),
            )
          ) {
            return;
          }
          if (name !== null && literalMessageFields.has(name)) {
            check(node.value);
          }
        },
        NewExpression(node) {
          if (node.callee.type === "Identifier" && /Error$/.test(node.callee.name)) {
            check(node.arguments[0]);
          }
        },
        JSXExpressionContainer(node) {
          if (node.parent.type !== "JSXElement") {
            return;
          }
          const name = node.parent.openingElement.name;
          if (name.type === "JSXIdentifier" && ["button", "a", "label", "option", "summary"].includes(name.name)) {
            return;
          }
          check(node.expression);
        },
        JSXText(node) {
          if (node.value.trim().length === 0) {
            return;
          }
          const parent = node.parent;
          if (
            parent.type === "JSXElement" &&
            parent.openingElement.name.type === "JSXIdentifier" &&
            ["button", "a", "label", "option", "summary"].includes(parent.openingElement.name.name)
          ) {
            return;
          }
          context.report({ node, messageId: "constant" });
        },
      };
    },
  }),
};
