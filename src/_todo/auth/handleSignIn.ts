import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/auth/handleSignIn')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/auth/handleSignIn"!</div>
}
