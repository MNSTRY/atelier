import { createHash } from 'node:crypto';
import { parseDefinition, parsePlacement, need, isRef, deepFreeze } from './wire.mjs';
export const digestBytes = bytes => createHash('sha256').update(bytes).digest('hex');

// A host-owned immutable snapshot, not a mutable catalogue or remote importer.
export function createRegistrySnapshot({ definitionBytes, rendererBytes, revision, lifecycle = 'active', allowDeprecated = false, validateProps, validateIntent }) {
  const definition = deepFreeze(parseDefinition(definitionBytes));
  need(isRef(revision) && ['active', 'deprecated', 'withdrawn', 'revoked'].includes(lifecycle));
  need(typeof validateProps === 'function' && typeof validateIntent === 'function');
  const definitionDigest = digestBytes(definitionBytes), rendererDigest = digestBytes(rendererBytes);
  return Object.freeze({ definition, revision, definitionDigest, rendererDigest, lifecycle,
    resolve({ sourceBytes, sourceRef, request, operationRef, serviceRef }) {
      need(lifecycle === 'active' || (lifecycle === 'deprecated' && allowDeprecated));
      const placement = deepFreeze(parsePlacement(sourceBytes));
      need(isRef(sourceRef) && isRef(serviceRef) && isRef(operationRef));
      need(placement.componentId === definition.componentId && placement.componentVersion === definition.version);
      need(placement.placementId === request.placementId && digestBytes(sourceBytes) === request.sourceDigest);
      need(definition.previewModes.includes(request.mode) && definition.projections.includes('web'));
      need(validateProps(placement.props) === true);
      need(placement.dataBindings.length === 1 && definition.dataContractRefs.includes(placement.dataBindings[0].contractRef));
      if (request.intentRef) need(validateIntent(request.intentRef, request.payload) === true);
      return deepFreeze({ resourceRef: placement.dataBindings[0].resourceRef, operationRef, serviceRef, sourceRef,
        placementRef: placement.placementId, sourceDigest: request.sourceDigest, descriptorDigest: definitionDigest,
        rendererDigest, registryRevision: revision, warning: lifecycle === 'deprecated' ? 'deprecated' : null });
    },
  });
}
