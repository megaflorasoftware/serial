import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/feed/useUpdateViewFilter')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/(feed)/feed/useUpdateViewFilter"!</div>
}
