import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** Ultima rede de seguranca: um erro de renderizacao nao pode deixar a tela em branco. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Sem servico de monitoramento no projeto: o console do navegador e o unico destino.
    // eslint-disable-next-line no-console
    console.error('Erro de renderização', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="mx-auto mt-20 max-w-md rounded-xl border border-red-300 bg-red-50 p-6 text-center text-red-900"
      >
        <h1 className="font-serif text-xl font-bold">Algo deu errado</h1>
        <p className="mt-2 text-sm">
          Ocorreu um erro inesperado nesta tela. Recarregue a página para continuar.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 min-h-11 rounded-lg bg-red-600 px-4 font-semibold text-white hover:bg-red-500"
        >
          Recarregar
        </button>
      </div>
    );
  }
}
