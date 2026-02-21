'use client';

import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useGLTF, Environment, MeshTransmissionMaterial, Lightformer } from '@react-three/drei';
import { easing } from 'maath';
import { useControls } from 'leva';
import * as THREE from 'three';

interface FloatingLogoProps {
  showControls?: boolean;
}

function Logo(props: { config: Record<string, unknown>; [key: string]: unknown }) {
  const { nodes } = useGLTF('/logo.glb') as unknown as {
    nodes: { Curve: { geometry: THREE.BufferGeometry } };
  };
  const meshRef = React.useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (meshRef.current?.material) {
      const rawProgress = Math.min(state.clock.elapsedTime / 0.5, 1);
      const progress = Math.pow(rawProgress, 2);
      (meshRef.current.material as THREE.Material & { opacity: number }).opacity = progress;
    }
  });

  return React.createElement(
    'group',
    { ...props, dispose: null },
    React.createElement(
      'mesh',
      {
        ref: meshRef,
        geometry: nodes.Curve.geometry,
        rotation: [0, 0, -Math.PI * 0.5],
        scale: 0.2,
      },
      React.createElement(MeshTransmissionMaterial, {
        ...props.config,
        transparent: true,
        opacity: 0,
      }),
    ),
  );
}

useGLTF.preload('/logo.glb');

function Scene({ showControls = false }: { showControls?: boolean }) {
  const block = useRef<THREE.Group>(null);

  const defaultConfig = {
    backside: true,
    backsideThickness: 0.15,
    samples: 10,
    transmission: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.0,
    thickness: 3,
    chromaticAberration: -0.8,
    anisotropy: 0,
    roughness: 0.5,
    distortion: 3,
    distortionScale: 0,
    temporalDistortion: 0,
    ior: 1.5,
    iridescence: 1,
    iridescenceIOR: 0,
  };

  const controls = useControls({
    backside: { value: true },
    backsideThickness: { value: 0.15, min: 0, max: 2 },
    samples: { value: 10, min: 1, max: 32, step: 1 },
    transmission: { value: 1, min: 0, max: 1 },
    clearcoat: { value: 1, min: 0.1, max: 1 },
    clearcoatRoughness: { value: 0.0, min: 0, max: 1 },
    thickness: { value: 3, min: 0, max: 5 },
    chromaticAberration: { value: -0.8, min: -5, max: 5 },
    anisotropy: { value: 0, min: 0, max: 1, step: 0.01 },
    roughness: { value: 0.5, min: 0, max: 1, step: 0.01 },
    distortion: { value: 3, min: 0, max: 4, step: 0.01 },
    distortionScale: { value: 0, min: 0.01, max: 1, step: 0.01 },
    temporalDistortion: { value: 0, min: 0, max: 1, step: 0.01 },
    ior: { value: 1.5, min: 0, max: 2, step: 0.01 },
    iridescence: { value: 1, min: 0, max: 2, step: 0.1 },
    iridescenceIOR: { value: 0, min: 0, max: 2, step: 0.1 },
  });

  const config = showControls ? controls : defaultConfig;

  useFrame((state, delta) => {
    if (block.current) {
      const { x, y } = state.pointer;
      easing.dampE(
        block.current.rotation,
        [x * Math.PI * 0.05, 0, -y * Math.PI * 0.05],
        0.5,
        delta,
      );
      const time = state.clock.elapsedTime;
      block.current.position.y = Math.sin(time * 2) * 0.05;
    }
  });

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      Environment,
      { resolution: 16 },
      React.createElement(
        'group',
        { rotation: [-Math.PI / 4, -0.3, 0] },
        React.createElement(Lightformer, {
          color: '#ffffff',
          intensity: 2,
          rotation: [0, Math.PI / 2, 0],
          position: [-2, 0.5, -0.5],
          scale: [4, 1, 0.5],
        }),
        React.createElement(Lightformer, {
          color: '#ffffff',
          intensity: 2,
          rotation: [0, Math.PI / 2, 0],
          position: [-2, -0.5, -0.5],
          scale: [4, 1, 0.5],
        }),
        React.createElement(Lightformer, {
          color: '#ffffff',
          intensity: 1,
          rotation: [0, -Math.PI / 2, 0],
          position: [4, 0.5, 0],
          scale: [8, 1, 0.5],
        }),
        React.createElement(Lightformer, {
          color: '#ffffff',
          type: 'ring',
          intensity: 2,
          rotation: [0, Math.PI / 2, 0],
          position: [-0.05, -0.5, -2.5],
          scale: 5,
        }),
      ),
    ),
    React.createElement(
      'group',
      { ref: block },
      React.createElement(Logo, {
        position: [0, -2.5, 1.3],
        rotation: [Math.PI / 2, 0, 0],
        config: config,
      }),
    ),
  );
}

export default function FloatingLogo({ showControls = false }: FloatingLogoProps) {
  return React.createElement(
    'div',
    {
      className: `absolute inset-0 z-0`,
      style: { width: '100%', height: '1000px' },
    },
    React.createElement(
      Canvas,
      {
        shadows: true,
        gl: { alpha: true },
        camera: { fov: 10, near: 0.1, far: 100, position: [40, 20, 30] },
      },
      React.createElement(Scene, { showControls }),
    ),
  );
}
