export const enRead = {
  incomplete: 'Sign-in did not complete',
  retry: 'Try signing in again',
  noArtefacts: 'Nothing has been published yet.',
  landingLead: 'Published documents',
  searchLabel: 'Search documents',
  tagFilter: 'Filter by tag',
  allTags: 'All tags',
  search: 'Search',
  clear: 'Clear',
  noMatches: 'No documents match your search.',
  documents: (total: number, matches?: number) =>
    `${matches === undefined ? '' : `${matches} of `}${total} ${total === 1 ? 'document' : 'documents'}`,
}

export const frRead: typeof enRead = {
  incomplete: 'La connexion n’a pas abouti',
  retry: 'Réessayer de se connecter',
  noArtefacts: 'Aucun artefact publié pour le moment.',
  landingLead: 'Documents publiés',
  searchLabel: 'Rechercher des documents',
  tagFilter: 'Filtrer par tag',
  allTags: 'Tous les tags',
  search: 'Rechercher',
  clear: 'Effacer',
  noMatches: 'Aucun document ne correspond à votre recherche.',
  documents: (total: number, matches?: number) =>
    `${matches === undefined ? '' : `${matches} sur `}${total} ${total <= 1 ? 'document' : 'documents'}`,
}
