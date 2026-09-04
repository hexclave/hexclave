const CONFETTI_COLORS = Object.freeze([
  "#fef3c7",
  "#fde68a",
  "#fbbf24",
  "#f59e0b",
  "#fff7ed",
]);
const CONFETTI_PARTICLE_COUNT = 72;

function createConfettiParticle(index, width, height) {
  const fromLeft = index % 2 === 0;
  const viewportScale = Math.min(2, Math.max(1, width / 1920));
  const horizontalProgress = ((index * 47 + 13) % 97) / 96;
  const verticalProgress = ((index * 61 + 29) % 101) / 100;
  const inwardPosition = 0.04 + horizontalProgress * 0.39;
  return {
    x: fromLeft ? width * inwardPosition : width * (1 - inwardPosition),
    y: height * (0.07 + verticalProgress * 0.82),
    rotation: (((index * 37 + 11) % 180) * Math.PI) / 180,
    width: (5 + ((index * 17) % 9)) * viewportScale,
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length] ?? "#fde68a",
  };
}

function renderStaticConfetti(container) {
  const canvas = document.createElement("canvas");
  canvas.className = "tv-confetti-canvas";
  canvas.setAttribute("aria-hidden", "true");
  container.append(canvas);

  const context = canvas.getContext("2d");
  if (context == null) return () => canvas.remove();
  const width = Math.max(1, Math.floor(container.clientWidth));
  const height = Math.max(1, Math.floor(container.clientHeight));
  // A one-to-one backing buffer is deliberate. Rendering the short entrance at
  // device pixel ratio 2 quadruples canvas work without improving TV-distance legibility.
  canvas.width = width;
  canvas.height = height;
  const particles = Array.from(
    { length: CONFETTI_PARTICLE_COUNT },
    (_, index) => createConfettiParticle(index, width, height),
  );
  for (const particle of particles) {
    context.save();
    context.translate(particle.x, particle.y);
    context.rotate(particle.rotation);
    context.fillStyle = particle.color;
    context.globalAlpha = 0.58;
    context.fillRect(-particle.width / 2, -2, particle.width, 4);
    context.restore();
  }
  context.globalAlpha = 1;
  return () => canvas.remove();
}

export function createCelebrationLayer(container) {
  if (!(container instanceof HTMLElement)) {
    throw new Error("TV Box celebration layer requires an HTML element.");
  }

  let activeSignature = null;
  let clearActiveEffect = null;

  function stop() {
    clearActiveEffect?.();
    clearActiveEffect = null;
    activeSignature = null;
    container.dataset.ambientEffects = "inactive";
    container.dataset.entryBurst = "inactive";
    container.dataset.takeoverEffects = "inactive";
    container.replaceChildren();
  }

  function update(options) {
    const signature = JSON.stringify(options);
    if (signature === activeSignature) return;
    stop();
    activeSignature = signature;
    container.dataset.ambientEffects = options.ambientActive ? "active" : "inactive";
    container.dataset.entryBurst = options.entryBurst ? "active" : "inactive";
    container.dataset.takeoverEffects = options.takeoverActive ? "active" : "inactive";
    if (options.entryBurst && options.takeoverActive && options.foreground) {
      clearActiveEffect = renderStaticConfetti(container);
    }
  }

  return { update, destroy: stop };
}
