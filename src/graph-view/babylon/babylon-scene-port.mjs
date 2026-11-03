import { referenceKey } from './semantic-picking.mjs'

// Inject the exact locally supplied Babylon symbols and engine. No browser globals,
// engine construction, camera attachControl, subscriptions or scheduler live here.
export function createBabylonPortFactory(B, engine, { onSceneCreated = () => {} } = {}) {
  return (profile, bind) => {
    const scene = new B.Scene(engine)
    try {
      scene.useRightHandedSystem = true
      scene.clearColor = new B.Color4(0.098, 0.102, 0.098, 1)
      const camera = new B.ArcRotateCamera('view-camera', Math.PI / 2, 1.41, 10, B.Vector3.Zero(), scene)
      camera.lowerRadiusLimit = 4
      camera.upperRadiusLimit = 55
      const light = new B.HemisphericLight('view-light', new B.Vector3(0, 1, 0), scene)
      light.intensity = 1.5
      const nodes = new Map()
      const pickable = new Set()
      for (const [index, node] of profile.nodes.entries()) {
        // The mesh name is intentionally unrelated to domain identity.
        const mesh = B.MeshBuilder.CreateSphere(`node-glyph-${index}`, { diameter: 0.5, segments: 12 }, scene)
        mesh.position.copyFromFloats(...node.position)
        const material = new B.StandardMaterial(`glyph-material-${index}`, scene)
        material.diffuseColor = new B.Color3(0.65, 0.70, 0.72)
        material.specularColor = new B.Color3(0.2, 0.2, 0.15)
        mesh.material = material
        nodes.set(referenceKey(node.ref), mesh)
        pickable.add(mesh)
        bind(mesh, node)
      }
      profile.edges.forEach((edge, index) => {
        const line = B.MeshBuilder.CreateLines(`relation-${index}`, {
          points: [nodes.get(referenceKey(edge.from)).position, nodes.get(referenceKey(edge.to)).position],
        }, scene)
        line.isPickable = false
        line.color = new B.Color3(0.45, 0.48, 0.44)
      })
      onSceneCreated({ scene, camera }) // Local host/qualifier seam; never a semantic event.
      return {
        render() { scene.render() },
        pick(x, y) {
          const hit = scene.pick(x, y, mesh => pickable.has(mesh))
          return hit?.hit ? hit.pickedMesh : null
        },
        focus(position) { camera.setTarget(B.Vector3.FromArray(position)) },
        select(ref) {
          const key = ref ? referenceKey(ref) : null
          for (const [nodeKey, mesh] of nodes) {
            const selected = key === nodeKey
            mesh.scaling.setAll(selected ? 1.3 : 1)
            mesh.material.emissiveColor = selected ? new B.Color3(0.44, 0.35, 0.17) : B.Color3.Black()
          }
        },
        dispose() {
          nodes.clear()
          pickable.clear()
          scene.dispose()
        },
      }
    } catch (error) {
      scene.dispose()
      throw error
    }
  }
}
