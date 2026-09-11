/**
 * ExtractedArticle — port of Shared/Article Extractor/ExtractedArticle.swift
 *
 * The reader-view payload returned by the article extractor service. JSON keys are
 * snake_case on the wire; extractedArticleKeys maps every field to the key it decodes from.
 */

export interface ExtractedArticle {
  title?: string;
  author?: string;
  datePublished?: string;
  dek?: string;
  leadImageURL?: string;
  content?: string;
  nextPageURL?: string;
  url?: string;
  domain?: string;
  excerpt?: string;
  wordCount?: number;
  direction?: string;
  totalPages?: number;
  renderedPages?: number;
}

export class ExtractedArticleKeys {
  static readonly title: string = 'title';
  static readonly author: string = 'author';
  static readonly datePublished: string = 'date_published';
  static readonly dek: string = 'dek';
  static readonly leadImageURL: string = 'lead_image_url';
  static readonly content: string = 'content';
  static readonly nextPageURL: string = 'next_page_url';
  static readonly url: string = 'url';
  static readonly domain: string = 'domain';
  static readonly excerpt: string = 'excerpt';
  static readonly wordCount: string = 'word_count';
  static readonly direction: string = 'direction';
  static readonly totalPages: string = 'total_pages';
  static readonly renderedPages: string = 'rendered_pages';
}
