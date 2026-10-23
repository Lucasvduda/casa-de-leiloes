import { useCallback, useState } from 'react';

/** Tema claro/escuro. O estado inicial ja foi aplicado por /theme-init.js, antes da pintura. */
export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  const toggle = useCallback(() => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // armazenamento bloqueado: o tema vale so ate recarregar
    }
    setDark(next);
  }, [dark]);

  return { dark, toggle };
}
