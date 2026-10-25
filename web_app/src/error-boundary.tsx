import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from './store/hooks';
import { runtimeActions } from './store/runtimeSlice';

function FatalError() {
  const error = useAppSelector(state => state.runtime.fatalError);
  return <div className="fatal"><h1>工作台无法显示数据</h1><p>{error ?? '页面渲染失败'}</p><button onClick={() => location.reload()}>重新加载</button></div>;
}

class CaptureBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  // React requires a private capture latch to stop rendering a failed subtree.
  // The displayed error and all application state belong to Redux.
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, _info: ErrorInfo) { this.props.onError(error.message); }
  render() {
    return this.state.failed ? <FatalError /> : this.props.children;
  }
}

export function ErrorBoundary({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  return <CaptureBoundary onError={message => dispatch(runtimeActions.fatalErrorSet(message))}>{children}</CaptureBoundary>;
}
