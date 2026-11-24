import type { SVGProps } from 'react'

/** The Diagram icon from the boards (04.8, 04.11): two boxes joined by an elbow. */
export function DiagramIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      aria-hidden
      {...props}
    >
      <rect x="3" y="3" width="7" height="6" />
      <rect x="14" y="15" width="7" height="6" />
      <path d="M6.5 9v3a2 2 0 0 0 2 2H17.5v1" />
    </svg>
  )
}
