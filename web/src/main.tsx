import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { makeQueryClient, Providers } from '@/providers'
import { makeRouter } from '@/router'
import './styles.css'

const client = makeQueryClient()
const router = makeRouter(undefined, client)

// biome-ignore lint/style/noNonNullAssertion: index.html always has #root
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
