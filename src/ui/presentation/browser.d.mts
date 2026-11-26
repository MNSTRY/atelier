import type { PresentationModel, PresentationTokenOverrides } from './index.mjs'

export interface PresentationRequest {
  readonly schema: 'atelier.presentation-request/v1'
  readonly version: '1.0.0'
  readonly presentationId: string
  readonly status: 'proposed'
  readonly executionAuthority: false
  readonly kind: 'action' | 'selection' | 'move' | 'resize' | 'edit'
  readonly id: string
  readonly actionRef?: string
  readonly presentationConfirmed?: boolean
  readonly itemId?: string
  readonly position?: number
  readonly value?: number | string
}

export interface BindPresentationOptions {
  onRequest?: (request: PresentationRequest) => void | Promise<void>
}

export interface UpdatePresentationOptions {
  discardDrafts?: boolean
  tokenOverrides?: PresentationTokenOverrides
}

export interface PresentationBindingHandle {
  readonly dispose: () => void
  readonly update: (
    nextModel: PresentationModel,
    options?: UpdatePresentationOptions,
  ) => Readonly<PresentationBindingHandle>
  readonly isComposing: boolean
  readonly hasPendingUpdate: boolean
}

export declare function bindPresentation(
  root: HTMLElement,
  model: PresentationModel,
  options?: BindPresentationOptions,
): Readonly<PresentationBindingHandle>
