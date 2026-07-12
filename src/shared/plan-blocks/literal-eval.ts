/**
 * Static evaluator for the estree ASTs that MDX attribute expressions carry
 * (`tabs={[…]}`, `code={"a\nb"}`). The plan dialect allows only data literals,
 * so this walks the tree and produces plain JSON values WITHOUT executing
 * anything — no eval, no Function, no identifier resolution. Anything beyond a
 * literal (identifiers, calls, member access, spreads, interpolation) throws
 * {@link NonLiteralError}, which the parser surfaces as a block issue.
 */

/** Thrown when an attribute expression is not a pure data literal. */
export class NonLiteralError extends Error {
  constructor(nodeType: string) {
    super(`non-literal expression (${nodeType}) — plan attributes must be static JSON literals`);
    this.name = 'NonLiteralError';
  }
}

/** Minimal estree node shape — kept structural so no estree types dependency
 *  leaks into the shared bundle. */
interface EstreeNode {
  type: string;
  [key: string]: unknown;
}

/** Evaluate a static-literal estree expression node to a plain JSON value. */
export function evaluateLiteral(node: EstreeNode): unknown {
  switch (node.type) {
    case 'Literal': {
      // Regex literals are objects with a `regex` payload — not data.
      if (typeof node.regex === 'object' && node.regex !== null)
        throw new NonLiteralError('RegExpLiteral');
      return node.value;
    }
    case 'TemplateLiteral': {
      const expressions = node.expressions as EstreeNode[];
      if (expressions.length > 0) throw new NonLiteralError('TemplateLiteral with ${…}');
      const quasis = node.quasis as Array<{ value: { cooked?: string; raw: string } }>;
      return quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
    }
    case 'UnaryExpression': {
      // Negative (and explicitly positive) numeric literals only.
      const operator = node.operator as string;
      const argument = node.argument as EstreeNode;
      if ((operator === '-' || operator === '+') && argument.type === 'Literal') {
        const value = evaluateLiteral(argument);
        if (typeof value === 'number') return operator === '-' ? -value : value;
      }
      throw new NonLiteralError(`UnaryExpression ${operator}`);
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as EstreeNode[]) {
        if (prop.type !== 'Property') throw new NonLiteralError(prop.type);
        if (prop.computed === true) throw new NonLiteralError('computed property');
        if (prop.kind !== 'init') throw new NonLiteralError(`${String(prop.kind)} property`);
        const key = prop.key as EstreeNode;
        let name: string;
        if (key.type === 'Identifier') name = key.name as string;
        else if (key.type === 'Literal' && typeof key.value === 'string') name = key.value;
        else throw new NonLiteralError(`property key ${key.type}`);
        out[name] = evaluateLiteral(prop.value as EstreeNode);
      }
      return out;
    }
    case 'ArrayExpression': {
      const out: unknown[] = [];
      for (const element of node.elements as Array<EstreeNode | null>) {
        if (element === null) throw new NonLiteralError('array hole');
        out.push(evaluateLiteral(element));
      }
      return out;
    }
    case 'Identifier': {
      if (node.name === 'undefined') return undefined;
      throw new NonLiteralError(`Identifier ${String(node.name)}`);
    }
    default:
      throw new NonLiteralError(node.type);
  }
}

/**
 * Extract the single expression from an MDX attribute-value estree Program
 * (`{…}` parses to a Program whose sole statement wraps the expression) and
 * evaluate it as a static literal.
 */
export function evaluateAttributeProgram(program: EstreeNode): unknown {
  const body = program.body as EstreeNode[];
  const statement = body.length === 1 ? body[0] : undefined;
  if (!statement || statement.type !== 'ExpressionStatement') {
    throw new NonLiteralError(statement ? statement.type : 'empty expression');
  }
  return evaluateLiteral(statement.expression as EstreeNode);
}
