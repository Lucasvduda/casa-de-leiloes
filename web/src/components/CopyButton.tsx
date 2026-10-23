import { useState } from 'react';
import { Button } from './ui';

/**
 * Copia texto para a area de transferencia. `navigator.clipboard` so existe em contexto seguro
 * (HTTPS/localhost); sem ele, avisa em vez de falhar calado.
 */
export function CopyButton({ text, label = 'Copiar' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2500);
  }

  return (
    <Button variant="secondary" className="min-h-9 px-3 text-xs" onClick={() => void copy()}>
      {state === 'copied' ? 'Copiado!' : state === 'failed' ? 'Não foi possível copiar' : label}
    </Button>
  );
}
