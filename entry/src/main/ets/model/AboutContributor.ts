/**
 * AboutContributor — port of iOS/Settings/AboutContributor.swift
 *
 * The static credits list the About screen renders. The order is the source's
 * Contributors.allCases order.
 */

export interface AboutContributor {
  name: string;
  url: string;
}

export const contributors: AboutContributor[] = [
  { name: 'Maurice Parker', url: 'https://vincode.io' },
  { name: 'Stuart Breckenridge', url: 'https://stuartbreckenridge.net' },
  { name: 'Brad Ellis', url: 'https://hachyderm.io/@bradellis' },
  { name: 'Kiel Gillard', url: 'https://twitter.com/kielgillard' },
  { name: 'Anh Do', url: 'https://mastodon.social/@anhdo' },
  { name: 'Nate Weaver', url: 'https://github.com/wevah' },
  { name: 'Andrew Brehaut', url: 'https://github.com/brehaut/' },
  { name: 'Daniel Jalkut', url: 'https://github.com/danielpunkass' },
  { name: 'Joe Heck', url: 'https://rhonabwy.com/' },
  { name: 'Olof Hellman', url: 'https://github.com/olofhellman' },
  { name: 'Rizwan Mohamed Ibrahim', url: 'https://blog.rizwan.dev/' },
  { name: 'Phil Viso', url: 'https://github.com/philviso' },
  { name: 'Ryan Dotson', url: 'https://github.com/nostodnayr' },
  {
    name: 'and many more',
    url: 'https://github.com/Ranchero-Software/NetNewsWire/graphs/contributors'
  }
];
