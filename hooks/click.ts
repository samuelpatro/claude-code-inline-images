import type { ClientModule } from 'claude-code'

/** A clear layer over a picture: a click on it posts the picture's path. */
const ClickLayer: ClientModule<{ path: string }, undefined> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type === 'up') surface.post({ path: props.path })
  })
  return surface.elements.Box({})
}

export default ClickLayer
