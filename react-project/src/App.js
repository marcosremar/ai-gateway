import { useEffect, useMemo, useState } from 'react';
import './App.css';
import PerformanceMonitor from './PerformanceMonitor';

const MOVE_STEP = 1;
const ENTRY_DISTANCE = 2.4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getDistance(a, b) {
  const dx = a.x - b.x;
  const y = a.y - b.y;
  return Math.sqrt(dx * dx + y * y);
}

function App() {
  const [location, setLocation] = useState('beach');
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const door = useMemo(() => ({ x: 0, y: -3 }), []);
  const distanceToDoor = getDistance(position, door);
  const canEnter = location === 'beach' && distanceToDoor <= ENTRY_DISTANCE;

  function move(dx, dy) {
    if (location !== 'beach') return;
    setPosition((current) => ({
      x: clamp(current.x + dx, -5, 5),
      y: clamp(current.y + dy, -5, 5),
    }));
  }

  function enterSchool() {
    if (!canEnter) return;
    setLocation('school');
  }

  function exitSchool() {
    setLocation('beach');
    setPosition({ x: 0, y: -2.4 });
  }

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'w') move(0, -MOVE_STEP);
      if (event.key === 'ArrowDown' || event.key.toLowerCase() === 's') move(0, MOVE_STEP);
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') move(-MOVE_STEP, 0);
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') move(MOVE_STEP, 0);
      if (event.key === 'Enter') enterSchool();
      if (event.key === 'Escape') exitSchool();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  return (
    <main className="App">
      <PerformanceMonitor />

      {location === 'beach' ? (
        <section className="world" aria-label="Curso de portugues de frente para a praia">
          <div className="sun" />
          <div className="cloud cloud-one" />
          <div className="cloud cloud-two" />
          <div className="ocean">
            <div className="wave wave-one" />
            <div className="wave wave-two" />
            <div className="wave wave-three" />
          </div>
          <div className="sand">
            <span className="shell shell-one" />
            <span className="shell shell-two" />
            <span className="palm palm-left" />
            <span className="palm palm-right" />
          </div>

          <div className="school" style={{ transform: `translateX(${position.x * -14}px)` }}>
            <div className="school-roof" />
            <div className="school-sign">
              <span>Curso de Portugues</span>
              <small>em frente a praia</small>
            </div>
            <div className="school-body">
              <div className="window window-left">Olá</div>
              <button
                className={`door ${canEnter ? 'door-ready' : ''}`}
                onClick={enterSchool}
                aria-label="Entrar no curso de portugues"
              >
                Entrar
              </button>
              <div className="window window-right">Praia</div>
            </div>
            <div className="steps" />
          </div>

          <div
            className="student"
            style={{
              transform: `translate(calc(-50% + ${position.x * 34}px), ${position.y * 28}px)`,
            }}
            aria-label="Aluno controlavel"
          >
            <span className="student-head" />
            <span className="student-body" />
          </div>

          <div className="hud">
            <strong>Curso de Portugues Atlantico</strong>
            <span>Fique de frente para a escola e aproxime-se da porta.</span>
            <span className={canEnter ? 'hud-ready' : ''}>
              {canEnter ? 'Entrada liberada' : `Distancia da porta: ${distanceToDoor.toFixed(1)}m`}
            </span>
          </div>

          <div className="controls" aria-label="Controles de movimento">
            <button onClick={() => move(0, -MOVE_STEP)} aria-label="Andar para frente">↑</button>
            <button onClick={() => move(-MOVE_STEP, 0)} aria-label="Andar para esquerda">←</button>
            <button onClick={() => move(0, MOVE_STEP)} aria-label="Andar para tras">↓</button>
            <button onClick={() => move(MOVE_STEP, 0)} aria-label="Andar para direita">→</button>
            <button className="enter-button" onClick={enterSchool} disabled={!canEnter}>
              Entrar
            </button>
          </div>
        </section>
      ) : (
        <section className="classroom" aria-label="Interior do curso de portugues">
          <div className="classroom-window">
            <span />
          </div>
          <div className="board">
            <strong>Aula 1</strong>
            <span>Olá, eu estudo português perto da praia.</span>
            <span>Bom dia · Obrigado · Até logo</span>
          </div>
          <div className="teacher-desk">Recepção</div>
          <div className="desks">
            <span>Vocabulário</span>
            <span>Conversação</span>
            <span>Pronúncia</span>
          </div>
          <button className="exit-door" onClick={exitSchool}>
            Sair para a praia
          </button>
        </section>
      )}
    </main>
  );
}

export default App;
