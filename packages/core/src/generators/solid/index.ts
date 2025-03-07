import dedent from 'dedent';
import { format } from 'prettier/standalone';
import { hasCss } from '../../helpers/styles/helpers';
import { getRefs } from '../../helpers/get-refs';
import { renderPreComponent } from '../../helpers/render-imports';
import { selfClosingTags } from '../../parsers/jsx';
import { MitosisComponent } from '../../types/mitosis-component';
import { checkIsForNode, MitosisNode } from '../../types/mitosis-node';
import {
  runPostCodePlugins,
  runPostJsonPlugins,
  runPreCodePlugins,
  runPreJsonPlugins,
} from '../../modules/plugins';
import { fastClone } from '../../helpers/fast-clone';
import { stripMetaProperties } from '../../helpers/strip-meta-properties';
import { getComponentsUsed } from '../../helpers/get-components-used';
import traverse from 'traverse';
import { isMitosisNode } from '../../helpers/is-mitosis-node';
import { TranspilerGenerator } from '../../types/transpiler';
import { filterEmptyTextNodes } from '../../helpers/filter-empty-text-nodes';
import { createMitosisNode } from '../../helpers/create-mitosis-node';
import { hasContext } from '../helpers/context';
import { babelTransformExpression } from '../../helpers/babel-transform';
import { types } from '@babel/core';
import { kebabCase } from 'lodash';
import { ToSolidOptions } from './types';
import { getState } from './state';
import { checkIsDefined } from '../../helpers/nullable';
import { stringifyContextValue } from '../../helpers/get-state-object-string';
import { collectCss } from '../../helpers/styles/collect-css';
import hash from 'hash-sum';
import { uniq } from 'fp-ts/lib/Array';
import * as S from 'fp-ts/string';
import { updateStateCode } from './state/helpers';
import { mergeOptions } from '../../helpers/merge-options';
import { CODE_PROCESSOR_PLUGIN } from '../../helpers/plugins/process-code';

// Transform <foo.bar key="value" /> to <component :is="foo.bar" key="value" />
function processDynamicComponents(json: MitosisComponent, options: ToSolidOptions) {
  let found = false;
  traverse(json).forEach((node) => {
    if (isMitosisNode(node)) {
      if (node.name.includes('.')) {
        node.bindings.component = { code: node.name };
        node.name = 'Dynamic';
        found = true;
      }
    }
  });
  return found;
}

function getContextString(component: MitosisComponent, options: ToSolidOptions) {
  let str = '';
  for (const key in component.context.get) {
    str += `
      const ${key} = useContext(${component.context.get[key].name});
    `;
  }

  return str;
}

// This should really be a preprocessor mapping the `class` attribute binding based on what other values have
// to make this more pluggable
const collectClassString = (json: MitosisNode, options: ToSolidOptions): string | null => {
  const staticClasses: string[] = [];

  if (json.properties.class) {
    staticClasses.push(json.properties.class);
    delete json.properties.class;
  }
  if (json.properties.className) {
    staticClasses.push(json.properties.className);
    delete json.properties.className;
  }

  const dynamicClasses: string[] = [];
  if (typeof json.bindings.class?.code === 'string') {
    dynamicClasses.push(json.bindings.class.code as any);
    delete json.bindings.class;
  }
  if (typeof json.bindings.className?.code === 'string') {
    dynamicClasses.push(json.bindings.className.code as any);
    delete json.bindings.className;
  }
  if (
    typeof json.bindings.css?.code === 'string' &&
    json.bindings.css.code.trim().length > 4 &&
    options.stylesType === 'styled-components'
  ) {
    dynamicClasses.push(`css(${json.bindings.css.code})`);
  }
  delete json.bindings.css;
  const staticClassesString = staticClasses.join(' ');

  const dynamicClassesString = dynamicClasses.join(" + ' ' + ");

  const hasStaticClasses = Boolean(staticClasses.length);
  const hasDynamicClasses = Boolean(dynamicClasses.length);

  if (hasStaticClasses && !hasDynamicClasses) {
    return `"${staticClassesString}"`;
  }

  if (hasDynamicClasses && !hasStaticClasses) {
    return `{${dynamicClassesString}}`;
  }

  if (hasDynamicClasses && hasStaticClasses) {
    return `{"${staticClassesString} " + ${dynamicClassesString}}`;
  }

  return null;
};

const preProcessBlockCode = ({
  json,
  options,
  component,
}: {
  json: MitosisNode;
  options: ToSolidOptions;
  component: MitosisComponent;
}) => {
  for (const key in json.properties) {
    const value = json.properties[key];
    if (value) {
      json.properties[key] = updateStateCode({ options, component, updateSetters: false })(value);
    }
  }
  for (const key in json.bindings) {
    const value = json.bindings[key];
    if (value?.code) {
      json.bindings[key] = {
        arguments: value.arguments,
        code: updateStateCode({ options, component, updateSetters: true })(value.code),
        type: value?.type,
      };
    }
  }
};

const blockToSolid = ({
  json,
  options,
  component,
}: {
  json: MitosisNode;
  options: ToSolidOptions;
  component: MitosisComponent;
}): string => {
  if (json.properties._text) {
    return json.properties._text;
  }
  if (json.bindings._text?.code) {
    return `{${json.bindings._text.code}}`;
  }

  if (checkIsForNode(json)) {
    const needsWrapper = json.children.length !== 1;
    // The SolidJS `<For>` component has a special index() signal function.
    // https://www.solidjs.com/docs/latest#%3Cfor%3E
    return `<For each={${json.bindings.each?.code}}>
    {(${json.scope.forName}, _index) => {
      const ${json.scope.indexName || 'index'} = _index();
      return ${needsWrapper ? '<>' : ''}${json.children
      .filter(filterEmptyTextNodes)
      .map((child) => blockToSolid({ component, json: child, options }))}}}
      ${needsWrapper ? '</>' : ''}
    </For>`;
  }

  let str = '';

  if (json.name === 'Fragment') {
    str += '<';
  } else {
    str += `<${json.name} `;
  }

  if (json.name === 'Show' && json.meta.else) {
    str += `fallback={${blockToSolid({ component, json: json.meta.else as any, options })}}`;
  }

  const classString = collectClassString(json, options);
  if (classString) {
    str += ` class=${classString} `;
  }

  for (const key in json.properties) {
    const value = json.properties[key];
    str += ` ${key}="${value}" `;
  }
  for (const key in json.bindings) {
    const { code, arguments: cusArg = ['event'], type } = json.bindings[key]!;
    if (!code) continue;

    if (type === 'spread') {
      str += ` {...(${code})} `;
    } else if (key.startsWith('on')) {
      const useKey = key === 'onChange' && json.name === 'input' ? 'onInput' : key;
      str += ` ${useKey}={(${cusArg.join(',')}) => ${code}} `;
    } else {
      let useValue = code;
      if (key === 'style') {
        // Convert camelCase keys to kebab-case
        // TODO: support more than top level objects, may need
        // a runtime helper for expressions that are not a direct
        // object literal, such as ternaries and other expression
        // types
        useValue = babelTransformExpression(code, {
          ObjectExpression(path: babel.NodePath<babel.types.ObjectExpression>) {
            // TODO: limit to top level objects only
            for (const property of path.node.properties) {
              if (types.isObjectProperty(property)) {
                if (types.isIdentifier(property.key) || types.isStringLiteral(property.key)) {
                  const key = types.isIdentifier(property.key)
                    ? property.key.name
                    : property.key.value;
                  property.key = types.stringLiteral(kebabCase(key));
                }
              }
            }
          },
        });
      }
      str += ` ${key}={${useValue}} `;
    }
  }
  if (selfClosingTags.has(json.name)) {
    return str + ' />';
  }
  str += '>';
  if (json.children) {
    str += json.children
      .filter(filterEmptyTextNodes)
      .map((item) => blockToSolid({ component, json: item, options }))
      .join('\n');
  }

  if (json.name === 'Fragment') {
    str += '</>';
  } else {
    str += `</${json.name}>`;
  }

  return str;
};

const getRefsString = (json: MitosisComponent) =>
  Array.from(getRefs(json))
    .map((ref) => `let ${ref};`)
    .join('\n');

function addProviderComponents(json: MitosisComponent, options: ToSolidOptions) {
  for (const key in json.context.set) {
    const { name, value } = json.context.set[key];
    json.children = [
      createMitosisNode({
        name: `${name}.Provider`,
        children: json.children,
        ...(value && {
          bindings: {
            value: { code: stringifyContextValue(value) },
          },
        }),
      }),
    ];
  }
}

const DEFAULT_OPTIONS: ToSolidOptions = {
  state: 'signals',
  stylesType: 'styled-components',
  plugins: [],
};

export const componentToSolid: TranspilerGenerator<Partial<ToSolidOptions>> =
  (passedOptions) =>
  ({ component }) => {
    let json = fastClone(component);

    const options = mergeOptions(DEFAULT_OPTIONS, passedOptions);
    options.plugins = [
      ...(options.plugins || []),
      CODE_PROCESSOR_PLUGIN((codeType) =>
        updateStateCode({
          component: json,
          options,
          updateSetters: codeType === 'properties' ? false : true,
        }),
      ),
    ];

    if (options.plugins) {
      json = runPreJsonPlugins(json, options.plugins);
    }
    addProviderComponents(json, options);
    const componentHasStyles = hasCss(json);
    const addWrapper =
      json.children.filter(filterEmptyTextNodes).length !== 1 || options.stylesType === 'style-tag';
    if (options.plugins) {
      json = runPostJsonPlugins(json, options.plugins);
    }
    stripMetaProperties(json);
    const foundDynamicComponents = processDynamicComponents(json, options);
    const css =
      options.stylesType === 'style-tag' &&
      collectCss(json, {
        prefix: hash(json),
      });

    const state = getState({ json, options });
    const componentsUsed = getComponentsUsed(json);
    const componentHasContext = hasContext(json);

    const hasShowComponent = componentsUsed.has('Show');
    const hasForComponent = componentsUsed.has('For');

    const solidJSImports = uniq(S.Eq)(
      [
        componentHasContext ? 'useContext' : undefined,
        hasShowComponent ? 'Show' : undefined,
        hasForComponent ? 'For' : undefined,
        json.hooks.onMount?.code ? 'onMount' : undefined,
        ...(json.hooks.onUpdate?.length ? ['on', 'createEffect'] : []),
        ...(state?.import.solidjs ?? []),
      ].filter(checkIsDefined),
    );

    const storeImports = state?.import.store ?? [];

    let str = dedent`
    ${solidJSImports.length > 0 ? `import { ${solidJSImports.join(', ')} } from 'solid-js';` : ''}
    ${!foundDynamicComponents ? '' : `import { Dynamic } from 'solid-js/web';`}
    ${storeImports.length > 0 ? `import { ${storeImports.join(', ')} } from 'solid-js/store';` : ''}
    ${
      !componentHasStyles && options.stylesType === 'styled-components'
        ? ''
        : `import { css } from "solid-styled-components";`
    }
    ${renderPreComponent({ component: json, target: 'solid' })}

    function ${json.name}(props) {
      ${state?.str ?? ''}
      
      ${getRefsString(json)}
      ${getContextString(json, options)}

      ${!json.hooks.onMount?.code ? '' : `onMount(() => { ${json.hooks.onMount.code} })`}
      ${
        json.hooks.onUpdate
          ? json.hooks.onUpdate
              .map((hook, index) => {
                if (hook.deps) {
                  const hookName = `onUpdateFn_${index}`;
                  return `
                    function ${hookName}() { ${hook.code} };
                    createEffect(on(() => ${hook.deps}, ${hookName}));
                  `;
                } else {
                  // TO-DO: support `onUpdate` without `deps`
                  return '';
                }
              })
              .join('\n')
          : ''
      }

      return (${addWrapper ? '<>' : ''}
        ${json.children
          .filter(filterEmptyTextNodes)
          .map((item) => blockToSolid({ component, json: item, options }))
          .join('\n')}
        ${
          options.stylesType === 'style-tag' && css && css.trim().length > 4
            ? // We add the jsx attribute so prettier formats this nicely
              `<style jsx>{\`${css}\`}</style>`
            : ''
        }
        ${addWrapper ? '</>' : ''})
    }

    export default ${json.name};
  `;

    if (options.plugins) {
      str = runPreCodePlugins(str, options.plugins);
    }
    if (options.prettier !== false) {
      str = format(str, {
        parser: 'typescript',
        plugins: [require('prettier/parser-typescript'), require('prettier/parser-postcss')],
      });
    }
    if (options.plugins) {
      str = runPostCodePlugins(str, options.plugins);
    }
    return str;
  };
