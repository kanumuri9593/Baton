import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PORT lets two copies of the lab (with / without Baton) run side by side.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5173), strictPort: true },
});
