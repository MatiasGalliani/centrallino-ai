# VoiceLab: fix "No supported source was found" al hacer Test

El error pasa porque `new Audio(url)` intenta cargar la URL directamente; si el servidor devuelve 502 (JSON), el navegador no puede reproducirlo como audio.

**Solución:** usar `fetch()` para obtener el audio, comprobar que la respuesta sea correcta y reproducir con un blob URL.

## Reemplaza tu `handleTest` en VoiceLab.tsx por:

```tsx
const handleTest = async (id: string) => {
  setTestingId(id);
  try {
    const res = await fetch(`${API_BASE}/api/voices/${id}/preview`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      console.error("Preview failed:", err);
      setTestingId(null);
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const audio = new Audio(blobUrl);
    audio.onended = () => {
      URL.revokeObjectURL(blobUrl);
      setTestingId(null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      setTestingId(null);
    };
    await audio.play();
  } catch (e) {
    console.error("Preview error:", e);
    setTestingId(null);
  }
};
```

Así solo se reproduce cuando la respuesta es audio válido; si el backend devuelve 502, verás el error en consola y el botón vuelve a estar disponible.
