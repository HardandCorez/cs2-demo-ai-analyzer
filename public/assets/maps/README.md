# Local CS2 map exports for 3D Episode Replay

The 3D browser viewer loads Source 2 Viewer (S2V) glTF/GLB assets from here.
It does **not** run S2V's native .NET/OpenGL renderer.

1. Install S2V from https://s2v.app/.
2. In the CS2 installation, open e.g. game/csgo/maps/de_mirage.vpk.
3. Find maps/de_mirage.vmap_c, right-click > Decompile & export > glTF Binary.
   (Alternatively, use the official S2V CLI; see https://s2v.app/ValveResourceFormat/guides/exporting-maps.html.)
4. Prepare a browser-ready asset named scene.glb in this folder:
   public/assets/maps/de_mirage/scene.glb
   Or use scene.gltf plus its associated bin/textures, preserving relative paths.
5. If alignment with demoparser world coordinates needs correcting, add
   public/assets/maps/de_mirage/transform.json:

   { "scale": 1, "rotationYDeg": 0, "offset": [0, 0, 0] }

   These transforms affect the exported map scene, NOT the replay's player coordinates.
   Check two or more known landmarks in a demo to validate positioning and axis alignment.

The fallback grid and simplified player shapes work without any map exports. The
S2V glTF export does not reproduce all game lighting, physics, or scripted entities.
CS2 assets can be large: optimize scenes/textures for the web before use.

Do not commit or publish Valve game assets without verifying applicable rights.
The gitignore excludes the actual map asset directories by default.
