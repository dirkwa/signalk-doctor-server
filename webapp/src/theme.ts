// Bootstrap 5.3 reads `data-bs-theme` off the root element to pick the
// light or dark palette. The SK admin UI doesn't expose a toggle, and
// neither do we — instead we mirror the user's OS preference and react
// to changes live, so a user switching their desktop into night mode
// gets a matching console without reloading.
export function applyColorScheme(): void {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (isDark: boolean): void => {
    document.documentElement.setAttribute('data-bs-theme', isDark ? 'dark' : 'light');
  };
  apply(mql.matches);
  mql.addEventListener('change', (e) => {
    apply(e.matches);
  });
}
