import type { ClientModule } from 'claude-code'

/** A clear layer over a picture: a left click on it posts the picture's path. */
const ClickLayer: ClientModule<{ path: string }, undefined> = (props, surface) => {
  surface.onPointer(event => {
    if (event.type === 'up' && event.button === 'left') surface.post({ path: props.path })
  })
  return surface.elements.Box({})
}

export default ClickLayer
