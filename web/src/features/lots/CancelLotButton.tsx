import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { invalidateLotLists, invalidateMoney } from '../../app/query-keys';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/toast';
import { Button } from '../../components/ui';
import { messageForError } from '../../lib/messages';

/** Cancelar lote (so o dono). Pede confirmacao: nao se desfaz e devolve o valor ao lider. */
export function CancelLotButton({
  lotId,
  title,
  bidCount,
  onCancelled,
}: {
  lotId: string;
  title: string;
  bidCount: number;
  onCancelled?: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  async function confirm() {
    if (loading) return;
    setLoading(true);
    try {
      const result = await api.cancelLot(lotId);
      setOpen(false);
      toast.push(
        'success',
        result.refunded
          ? 'Lote cancelado. O valor reservado do líder foi devolvido.'
          : 'Lote cancelado.',
      );
      // O lote e as listas mudaram de estado; o dinheiro reservado voltou para a carteira de alguem.
      await queryClient.invalidateQueries({ queryKey: ['lot'] });
      invalidateLotLists(queryClient);
      invalidateMoney(queryClient);
      onCancelled?.();
    } catch (error) {
      setOpen(false);
      toast.push('error', messageForError(error));
      // Pode ter encerrado no meio do caminho: mostra o estado real.
      void queryClient.invalidateQueries({ queryKey: ['lot'] });
      invalidateLotLists(queryClient);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Cancelar lote
      </Button>
      <ConfirmDialog
        open={open}
        title="Cancelar este lote?"
        confirmLabel="Sim, cancelar lote"
        danger
        loading={loading}
        onConfirm={() => void confirm()}
        onCancel={() => setOpen(false)}
      >
        <p>
          <strong>{title}</strong>
        </p>
        <p className="mt-2">
          {bidCount > 0
            ? `Há ${bidCount} ${bidCount === 1 ? 'lance' : 'lances'}. O licitante líder terá o valor devolvido e ninguém levará o item.`
            : 'Ainda não há lances.'}{' '}
          Esta ação não pode ser desfeita.
        </p>
      </ConfirmDialog>
    </>
  );
}
