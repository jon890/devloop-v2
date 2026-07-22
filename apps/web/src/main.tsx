import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  return (
    <main>
      <h1>Dooray 지식그래프</h1>
      <p>Phase 0 웹 스캐폴드가 준비되었습니다.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
