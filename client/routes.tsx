/* eslint-disable react/jsx-key */
import { createRoutesFromElements, Route } from 'react-router'
import App from './components/App'

// Create routes with App as the root component
const routes = createRoutesFromElements(
  <Route path="/*" element={<App />} />
)

export default routes
