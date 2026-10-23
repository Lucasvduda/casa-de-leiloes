import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('quebrou');
}

describe('ErrorBoundary', () => {
  it('renderiza os filhos normalmente', () => {
    render(
      <ErrorBoundary>
        <p>tudo certo</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('tudo certo')).toBeInTheDocument();
  });

  it('erro de renderizacao vira tela de aviso com botao de recarregar (nunca tela em branco)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Algo deu errado');
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
