import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function Harness({ onConfirm = () => undefined }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        abrir
      </button>
      <ConfirmDialog
        open={open}
        title="Cancelar lote?"
        confirmLabel="Cancelar lote"
        danger
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      >
        Esta ação não pode ser desfeita.
      </ConfirmDialog>
    </>
  );
}

describe('ConfirmDialog', () => {
  it('fechado nao desenha nada', () => {
    render(<Harness />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('abre com nome e descricao acessiveis e foco no botao SEGURO (Voltar)', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'abrir' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Cancelar lote?' });
    expect(dialog).toHaveAccessibleDescription('Esta ação não pode ser desfeita.');
    expect(screen.getByRole('button', { name: 'Voltar' })).toHaveFocus();
  });

  it('Esc cancela e devolve o foco a quem abriu', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'abrir' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Tab nao escapa do dialogo (circula entre os dois botoes)', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'abrir' }));
    const back = screen.getByRole('button', { name: 'Voltar' });
    const confirm = screen.getByRole('button', { name: 'Cancelar lote' });
    expect(back).toHaveFocus();
    await userEvent.tab();
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(back).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
  });

  it('confirmar chama onConfirm; Voltar nao', async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'abrir' }));
    await userEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'abrir' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar lote' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('enquanto carrega, Esc e clique fora NAO fecham (evita abandonar a acao no meio)', async () => {
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="T"
        confirmLabel="Ok"
        loading
        onConfirm={() => undefined}
        onCancel={onCancel}
      >
        x
      </ConfirmDialog>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });
});
