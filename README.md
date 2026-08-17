# Vitreous Floaters

An interactive WebGPU study of the visual field behind closed eyelids: retinal scintillation, transmitted eyelid colour, and soft vitreous-floater shadows moving through a viscoelastic simulation.

**Live site:** https://djui.github.io/vitreous-floaters/

## Features

- Procedural closed-eye colour and continuously fluctuating retinal noise
- Physically constrained, slowly reshaping fibre shadows with true optical blur
- Simulated saccades plus optional swipe, webcam eye-tracking, and phone-motion input
- A gradually cycling eyelid-pressure control
- An information panel covering the underlying optics, physiology, and perception

Camera and motion processing remain local to the browser. A WebGPU-capable browser is required.

## Development

```bash
npm install
npm run dev
```

Validate a production build with:

```bash
npm run typecheck
npm run build
```
