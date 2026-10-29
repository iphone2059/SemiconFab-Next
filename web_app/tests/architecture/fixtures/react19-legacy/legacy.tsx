import { forwardRef, useRef, type LegacyRef, type ReactNode } from 'react';
import type * as React from 'react';

// Negative fixture: every pattern below is a React 18-era idiom removed by the
// React 19 modernization gate. The file stays type-checkable via @ts-expect-error
// where React 19 types already reject the legacy form.
export const LegacyWidget = forwardRef<HTMLDivElement, { readonly children?: ReactNode }>(function LegacyWidget(
  props,
  ref,
) {
  return <div ref={ref}>{props.children}</div>;
});

declare const legacyComponent: { defaultProps?: unknown; propTypes?: unknown };
legacyComponent.defaultProps = { children: null };
legacyComponent.propTypes = {};

export const LegacyBox: React.FC = () => <div />;
export type LegacyRefAlias = LegacyRef<HTMLDivElement>;
export type LegacyEvent = React.FormEvent<HTMLFormElement>;

declare const ReactDOM: { render: (element: unknown, container: unknown) => void };
ReactDOM.render(<div />, document.body);
declare const legacyFind: { findDOMNode: (instance: unknown) => unknown };
legacyFind.findDOMNode(document.body);

// @ts-expect-error React 19 types removed the global JSX namespace; the gate must flag it
export function legacyReturn(): JSX.Element {
  return <div />;
}

// @ts-ignore legacy suppression is itself a gate violation
export const legacyValue: number = 'not-a-number';

// @ts-expect-error useRef requires an initial value in React 19
const noArgRef = useRef<HTMLDivElement>();
export { noArgRef };