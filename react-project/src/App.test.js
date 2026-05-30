import { render, screen } from '@testing-library/react';
import App from './App';

test('renders beachfront Portuguese course scene', () => {
  render(<App />);
  expect(screen.getByLabelText(/Curso de portugues de frente para a praia/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Entrar no curso de portugues/i })).toBeInTheDocument();
});
